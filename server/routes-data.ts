import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, setting } from './db.ts'
import { MUNICIPALITIES } from './municipalities.ts'
import { callList, coverageGaps, feedStatus } from './events.ts'
import { requireRole } from './auth.ts'
import { pollOnce, replayStep, setMode } from './luma.ts'

// Every response carries { lastReadingAt, stale, mode }.
export const withFeed = <T extends object>(data: T) => ({ ...feedStatus(), ...data })

// zod errors come back as { error: string } plus the feed, like every other response.
export const valid = <T extends 'json' | 'param' | 'query', S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, (r, c) => {
    if (!r.success) return c.json(withFeed({ error: `Entrada inválida: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}` }), 400)
  })

export const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Body too large' }, 413) })

const OrgBody = z.object({
  name: z.string().trim().min(2).max(120),
  orgType: z.enum(['health-plan', 'municipality', 'clinic', 'supplier', 'other']), // responders only; facilities are caregivers
  contactEmail: z.email().max(200),
  municipalities: z.array(z.enum(MUNICIPALITIES)).min(1).max(MUNICIPALITIES.length),
  message: z.string().trim().max(2000).default(''),
})

// Owned by A: public status, organization registration, call list, admin.
export const dataRoutes = new Hono()
  .use('/admin/*', requireRole('admin'))

  .get('/public/status', (c) => {
    const replay = setting('mode') === 'replay'
    const r = db.prepare(`SELECT payload FROM luma_readings WHERE endpoint = 'regions' AND ok = 1 AND source = 'live'
      ${replay ? 'AND id <= ?' : ''} ORDER BY id DESC LIMIT 1`).get(...(replay ? [Number(setting('replay_cursor'))] : [])) as { payload: string } | undefined
    const p = r ? (JSON.parse(r.payload) as { regions: Region[]; totals?: object; timestamp: string }) : null
    return c.json(withFeed({ regions: p?.regions ?? [], totals: p?.totals ?? null, lumaTimestamp: p?.timestamp ?? null }))
  })

  .post('/public/organizations', small, valid('json', OrgBody), (c) => {
    const b = c.req.valid('json')
    let id = 0
    db.exec('BEGIN')
    try {
      id = Number(db.prepare("INSERT INTO organizations (name, kind, org_type, contact_email, message, status) VALUES (?, 'responder', ?, ?, ?, 'pending')")
        .run(b.name, b.orgType, b.contactEmail, b.message).lastInsertRowid)
      const add = db.prepare('INSERT OR IGNORE INTO org_municipalities (org_id, municipality) VALUES (?, ?)')
      for (const m of b.municipalities) add.run(id, m)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return c.json(withFeed({ id, status: 'pending' as const }), 201)
  })

  .get('/call-list', requireRole('coordinator', 'admin'), (c) => c.json(withFeed({ events: callList(c.var.user) })))

  .get('/admin/readings', (c) => {
    const readings = db.prepare(`SELECT id, fetched_at, source, endpoint, http_status, ok, error, luma_timestamp, length(payload) AS bytes
      FROM luma_readings ORDER BY id DESC LIMIT 100`).all() as Reading[]
    return c.json(withFeed({ readings }))
  })

  // Live: poll LUMA now. Replay: advance one recorded reading (the presenter's "next").
  .post('/admin/poll', async (c) => {
    const readingId = setting('mode') === 'replay' ? replayStep() : (await pollOnce()).townsId
    return c.json(withFeed({ readingId }))
  })

  .put('/admin/mode', valid('json', z.object({ mode: z.enum(['live', 'replay']), fromReadingId: z.number().int().positive().optional() })), (c) => {
    const { mode, fromReadingId } = c.req.valid('json')
    if (!setMode(mode, fromReadingId)) return c.json(withFeed({ error: 'No recorded towns reading with that id' }), 400)
    return c.json(withFeed({}))
  })

  .get('/admin/organizations', (c) => {
    const rows = db.prepare(`SELECT o.id, o.name, o.org_type AS orgType, o.contact_email AS contactEmail, o.message, o.status, o.created_at AS createdAt,
        (SELECT json_group_array(municipality) FROM org_municipalities WHERE org_id = o.id) AS municipalities
      FROM organizations o WHERE o.kind = 'responder' ORDER BY o.status = 'pending' DESC, o.id`).all() as (Omit<Org, 'municipalities'> & { municipalities: string })[]
    return c.json(withFeed({ organizations: rows.map((o) => ({ ...o, municipalities: JSON.parse(o.municipalities) as string[] })) }))
  })

  .post('/admin/organizations/:id/review', valid('param', z.object({ id: z.coerce.number().int() })), valid('json', z.object({ decision: z.enum(['approve', 'reject']) })), (c) => {
    const { id } = c.req.valid('param')
    const status = c.req.valid('json').decision === 'approve' ? 'approved' : 'rejected'
    const changed = db.prepare(`UPDATE organizations SET status = ?, reviewed_by = ?, reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND kind = 'responder'`).run(status, c.var.user.id, id).changes
    if (!changed) return c.json(withFeed({ error: 'Organization not found' }), 404)
    return c.json(withFeed({ id, status }))
  })

  .get('/admin/coverage-gaps', (c) => c.json(withFeed({ patients: coverageGaps() })))

type Region = { name: string; totalClients: number; totalClientsWithoutService: number }
type Reading = { id: number; fetched_at: string; source: string; endpoint: string; http_status: number; ok: number; error: string | null; luma_timestamp: string | null; bytes: number | null }
type Org = { id: number; name: string; orgType: string; contactEmail: string; message: string; status: string; createdAt: string; municipalities: string[] }
