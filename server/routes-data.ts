import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db, setting } from './db.ts'
import { MUNICIPALITIES } from './municipalities.ts'
import { CHECKIN_MESSAGE, callList, coverageGaps, feedStatus } from './events.ts'
import { currentUser, requireRole } from './auth.ts'
import { pollOnce, replayStep, setMode } from './luma.ts'
import { twilioSend, waNumber, whatsappOn } from './whatsapp.ts'

// Every response carries { lastReadingAt, stale, mode }.
const withFeed = async <T extends object>(data: T) => ({ ...await feedStatus(), ...data })

// zod errors come back as { error: string } plus the feed, like every other response.
const valid = <T extends 'json' | 'param', S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, async (r, c) => {
    if (!r.success) return c.json(await withFeed({ error: `Entrada inválida: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}` }), 400)
  })

const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: 'Body too large' }, 413) })

const OrgBody = z.object({
  name: z.string().trim().min(2).max(120),
  orgType: z.enum(['health-plan', 'municipality', 'clinic', 'supplier', 'other']), // responders only; facilities are caregivers
  contactEmail: z.email().max(200),
  municipalities: z.array(z.enum(MUNICIPALITIES)).min(1).max(MUNICIPALITIES.length),
  message: z.string().trim().max(2000).default(''),
})

const admin = requireRole('admin')
// ponytail: one global cooldown for the WhatsApp test button; enough for a single presenter.
let lastWhatsappTest = 0
let lastSimulation = 0

// Owned by A: public status, organization registration, call list, admin.
export const dataRoutes = new Hono()
  .get('/public/status', async (c) => {
    const replay = await setting('mode') === 'replay'
    const r = await db.prepare(`SELECT payload FROM luma_readings WHERE endpoint = 'regions' AND ok = 1 AND source = 'live'
      ${replay ? 'AND id <= ?' : ''} ORDER BY id DESC LIMIT 1`).get(...(replay ? [Number(await setting('replay_cursor'))] : [])) as { payload: string } | undefined
    const p = r ? (JSON.parse(r.payload) as { regions: Region[]; totals?: object; timestamp: string }) : null
    return c.json(await withFeed({ regions: p?.regions ?? [], totals: p?.totals ?? null, lumaTimestamp: p?.timestamp ?? null }))
  })

  .post('/public/organizations', small, valid('json', OrgBody), async (c) => {
    const b = c.req.valid('json')
    const id = await db.tx(async () => {
      const { id } = await db.prepare("INSERT INTO organizations (name, kind, org_type, contact_email, message, status) VALUES (?, 'responder', ?, ?, ?, 'pending') RETURNING id")
        .get(b.name, b.orgType, b.contactEmail, b.message) as { id: number }
      const add = db.prepare('INSERT INTO org_municipalities (org_id, municipality) VALUES (?, ?) ON CONFLICT DO NOTHING')
      for (const m of b.municipalities) await add.run(id, m)
      return id
    })
    return c.json(await withFeed({ id, status: 'pending' as const }), 201)
  })

  .get('/call-list', requireRole('coordinator', 'admin'), async (c) => c.json(await withFeed({ events: await callList((await currentUser(c))!) })))

  .get('/admin/readings', admin, async (c) => {
    const readings = await db.prepare(`SELECT id, fetched_at, source, endpoint, http_status, ok, error, luma_timestamp, length(payload) AS bytes
      FROM luma_readings ORDER BY id DESC LIMIT 100`).all() as Reading[]
    return c.json(await withFeed({ readings }))
  })

  // Live: poll LUMA now. Replay: advance one recorded reading (the presenter's "next").
  .post('/admin/poll', admin, async (c) => {
    const readingId = await setting('mode') === 'replay' ? await replayStep() : (await pollOnce()).townsId
    return c.json(await withFeed({ readingId }))
  })

  .put('/admin/mode', admin, valid('json', z.object({ mode: z.enum(['live', 'replay']), fromReadingId: z.number().int().positive().optional() })), async (c) => {
    const { mode, fromReadingId } = c.req.valid('json')
    if (!await setMode(mode, fromReadingId)) return c.json(await withFeed({ error: 'No recorded towns reading with that id' }), 400)
    return c.json(await withFeed({}))
  })

  .get('/admin/organizations', admin, async (c) => {
    const rows = await db.prepare(`SELECT o.id, o.name, o.org_type AS orgType, o.contact_email AS contactEmail, o.message, o.status, o.created_at AS createdAt,
        (SELECT COALESCE(json_agg(municipality ORDER BY municipality), '[]')::text FROM org_municipalities WHERE org_id = o.id) AS municipalities
      FROM organizations o WHERE o.kind = 'responder' ORDER BY o.status = 'pending' DESC, o.id`).all() as (Omit<Org, 'municipalities'> & { municipalities: string })[]
    return c.json(await withFeed({ organizations: rows.map((o) => ({ ...o, municipalities: JSON.parse(o.municipalities) as string[] })) }))
  })

  .post('/admin/organizations/:id/review', admin, valid('param', z.object({ id: z.coerce.number().int() })), valid('json', z.object({ decision: z.enum(['approve', 'reject']) })), async (c) => {
    const { id } = c.req.valid('param')
    const status = c.req.valid('json').decision === 'approve' ? 'approved' : 'rejected'
    const { changes } = await db.prepare(`UPDATE organizations SET status = ?, reviewed_at = iso(now())
      WHERE id = ? AND kind = 'responder'`).run(status, id)
    if (!changes) return c.json(await withFeed({ error: 'Organization not found' }), 404)
    return c.json(await withFeed({ id, status }))
  })

  // Demo check of the Twilio setup. Only ever to WHATSAPP_DEMO_TO: anyone can become admin in the demo, so never a number from the body.
  .post('/admin/whatsapp-test', admin, async (c) => {
    if (!whatsappOn()) return c.json(await withFeed({ error: 'WhatsApp no está configurado' }), 503)
    const phone = waNumber(null)
    if (!phone) return c.json(await withFeed({ error: 'Falta WHATSAPP_DEMO_TO' }), 409)
    if (Date.now() - lastWhatsappTest < 10_000) return c.json(await withFeed({ error: 'Espere unos segundos antes de otra prueba' }), 429)
    lastWhatsappTest = Date.now()
    const time = new Date().toLocaleTimeString('es-PR', { timeZone: 'America/Puerto_Rico' })
    try {
      const sid = await twilioSend(phone, `VitalPower · mensaje de prueba (${time})`)
      return c.json(await withFeed({ sid, to: phone.slice(-4) }))
    } catch (e) {
      return c.json(await withFeed({ error: `WhatsApp no aceptó el mensaje: ${e instanceof Error ? e.message : e}` }), 502)
    }
  })

  // Demo: an outage reaches a seed patient's zone, without waiting for LUMA. Opens the same `possible` event and
  // check-in the feed would, so the WhatsApp sweep (5 s), the /app card, the reply and the call list all run unchanged.
  // to: 'patient' = the self-registered patient answers; 'caregiver' = a family caregiver answers for their patient.
  // ponytail: in live mode the next towns poll restores the case if LUMA does not list that zone; run it in replay for a steady demo.
  .post('/admin/simulate-checkin', admin, small, valid('json', z.object({ to: z.enum(['patient', 'caregiver']) })), async (c) => {
    // Same gates as the test button: the sweep must send only to WHATSAPP_DEMO_TO, and a cooldown keeps presses from piling up sends.
    if (whatsappOn() && !waNumber(null)) return c.json(await withFeed({ error: 'Falta WHATSAPP_DEMO_TO' }), 409)
    if (Date.now() - lastSimulation < 10_000) return c.json(await withFeed({ error: 'Espere unos segundos antes de otra prueba' }), 429)
    const mode = await setting('mode')
    const reading = await db.prepare('SELECT max(id) AS id FROM luma_readings').get() as { id: number | null }
    if (!reading.id) return c.json(await withFeed({ error: 'Todavía no hay lecturas de LUMA' }), 409)
    const p = await db.prepare(`SELECT p.id, p.display_name AS patient, u.name AS answeredBy FROM patients p JOIN users u ON u.id = p.caregiver_id
      WHERE p.is_self = ? AND p.facility_id IS NULL ORDER BY p.id LIMIT 1`).get(c.req.valid('json').to === 'patient' ? 1 : 0) as { id: number; patient: string; answeredBy: string } | undefined
    if (!p) return c.json(await withFeed({ error: 'No hay paciente para esta prueba' }), 404)
    // Never close a case an organization took: anyone can be admin in the demo. Reiniciar demo releases it.
    if (await db.prepare(`SELECT 1 FROM outage_events WHERE patient_id = ? AND mode = ? AND status IN ('possible','confirmed')
      AND claimed_by_org_id IS NOT NULL`).get(p.id, mode)) return c.json(await withFeed({ error: 'Una organización ya tomó el caso de este paciente. Reinicie la demostración.' }), 409)
    lastSimulation = Date.now()
    const eventId = await db.tx(async () => {
      // Pressing it again starts over: the patient's open, unclaimed case closes as a false alarm.
      await db.prepare(`UPDATE outage_events SET status = 'false_alarm', closed_at = iso(now())
        WHERE patient_id = ? AND mode = ? AND status IN ('possible','confirmed') AND claimed_by_org_id IS NULL`).run(p.id, mode)
      const { id } = await db.prepare('INSERT INTO outage_events (patient_id, opened_reading_id, mode) VALUES (?, ?, ?) RETURNING id').get(p.id, reading.id, mode) as { id: number }
      await db.prepare('INSERT INTO checkins (event_id, message) VALUES (?, ?)').run(id, CHECKIN_MESSAGE)
      return id
    })
    return c.json(await withFeed({ eventId, patient: p.patient, answeredBy: p.answeredBy, whatsapp: whatsappOn() }))
  })

  .get('/admin/coverage-gaps', admin, async (c) => c.json(await withFeed({ patients: await coverageGaps() })))

type Region = { name: string; totalClients: number; totalClientsWithoutService: number }
type Reading = { id: number; fetched_at: string; source: string; endpoint: string; http_status: number; ok: number; error: string | null; luma_timestamp: string | null; bytes: number | null }
type Org = { id: number; name: string; orgType: string; contactEmail: string; message: string; status: string; createdAt: string; municipalities: string[] }
