import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { COOKIE, currentUser, persona, personas, requireRole, type CurrentUser } from './auth.ts'
import { db, setting } from './db.ts'
import { claimEvent, feedStatus, setEventStatus } from './events.ts'
import type { NeedKind } from './priority.ts'

const withFeed = <T extends object>(data: T) => ({ ...feedStatus(), ...data })
const valid = <T extends 'json' | 'param', S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, (r, c) => {
    if (!r.success) return c.json(withFeed({ error: `Entrada inválida: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}` }), 400)
  })
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json(withFeed({ error: 'Texto demasiado largo' }), 413) })
const idParam = valid('param', z.object({ id: z.coerce.number().int().positive() }))
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const OPEN = "e.status IN ('possible','confirmed')"

// Visibility lives in the SQL, never in the UI.
// A caregiver sees the patients they registered plus their facility's (facility_id = NULL matches nothing).
const SEES = '(p.caregiver_id = :uid OR p.facility_id = :orgId)'
// A coordinator acts only in the municipalities of its approved organization; admin sees every municipality.
const COVERS = `(:all = 1 OR p.municipality IN (SELECT om.municipality FROM org_municipalities om JOIN organizations o ON o.id = om.org_id
  WHERE o.id = :orgId AND o.kind = 'responder' AND o.status = 'approved'))`
const scope = (u: CurrentUser) => ({ all: u.role === 'admin' ? 1 : 0, orgId: u.orgId, mode: setting('mode') })

type Need = { kind: NeedKind; batteryHours: number | null }
const NEEDS = "(SELECT json_group_array(json_object('kind', kind, 'batteryHours', battery_hours)) FROM patient_needs WHERE patient_id = p.id)"
type EventRow = {
  id: number; status: 'possible' | 'confirmed' | 'restored' | 'false_alarm'; openedAt: string; closedAt: string | null
  claimedByOrgId: number | null; claimedBy: string | null; claimedAt: string | null
  patientName: string; phone: string | null; municipality: string; zone: string | null; needs: string
}
// An event of the current mode that this coordinator (or admin) may see; undefined otherwise.
const eventFor = (u: CurrentUser, id: number) =>
  db.prepare(`SELECT e.id, e.status, e.opened_at AS openedAt, e.closed_at AS closedAt,
      e.claimed_by_org_id AS claimedByOrgId, o.name AS claimedBy, e.claimed_at AS claimedAt,
      p.display_name AS patientName, p.phone, p.municipality, p.zone, ${NEEDS} AS needs
    FROM outage_events e JOIN patients p ON p.id = e.patient_id LEFT JOIN organizations o ON o.id = e.claimed_by_org_id
    WHERE e.id = :id AND e.mode = :mode AND ${COVERS}`).get({ id, ...scope(u) }) as EventRow | undefined

type Checkin = { id: number; message: string; sentAt: string; replyText: string | null; replyAt: string | null; aiParsed: string | null; confirmedAt: string | null }
type Outcome = { id: number; reached: number; outcome: string; nextAction: string | null; createdAt: string; coordinator: string }

// Owned by B: demo login, intake, patients, check-ins, claim, events, briefings, outcomes.
export const appRoutes = new Hono()
  .onError((error, c) => {
    const bad = error instanceof HTTPException && error.status === 400 // malformed JSON body
    if (!bad) console.error(error)
    return c.json(withFeed({ error: bad ? 'Entrada inválida' : 'Error del API' }), bad ? 400 : 500)
  })
  .get('/demo/personas', (c) => c.json(withFeed({ personas: personas() })))
  .post('/demo/login', valid('json', z.object({ userId: z.number().int().positive() })), (c) => {
    const user = persona(c.req.valid('json').userId)
    if (!user) return c.json(withFeed({ error: 'Persona no encontrada' }), 404)
    setCookie(c, COOKIE, String(user.id), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 7 })
    return c.json(withFeed({ user }))
  })
  .post('/demo/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json(withFeed({ user: null }))
  })
  .get('/demo/me', (c) => {
    const user = currentUser(c)
    return c.json(withFeed({ user: user ? persona(user.id) : null }))
  })

  // Caregiver: own patients plus the facility's, each with its open outage (if any) in the current mode.
  .get('/patients/mine', requireRole('caregiver'), (c) => {
    const u = currentUser(c)!
    const rows = db.prepare(`SELECT p.id, p.display_name AS name, p.municipality, p.zone, p.is_self AS isSelf, ${NEEDS} AS needs,
        (SELECT e.status FROM outage_events e WHERE e.patient_id = p.id AND e.mode = :mode AND ${OPEN}) AS outage
      FROM patients p WHERE ${SEES} ORDER BY p.id`).all({ uid: u.id, orgId: u.orgId, mode: setting('mode') }) as
      { id: number; name: string; municipality: string; zone: string | null; isSelf: number; needs: string; outage: 'possible' | 'confirmed' | null }[]
    return c.json(withFeed({ patients: rows.map((p) => ({ ...p, isSelf: !!p.isSelf, needs: JSON.parse(p.needs) as Need[] })) }))
  })
  .get('/checkins/pending', requireRole('caregiver'), (c) => {
    const u = currentUser(c)!
    const checkins = db.prepare(`SELECT c.id, c.message, c.sent_at AS sentAt, p.id AS patientId, p.display_name AS patientName
      FROM checkins c JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
      WHERE c.reply_at IS NULL AND ${OPEN} AND e.mode = :mode AND ${SEES} ORDER BY c.id`).all({ uid: u.id, orgId: u.orgId, mode: setting('mode') }) as
      { id: number; message: string; sentAt: string; patientId: number; patientName: string }[]
    return c.json(withFeed({ checkins }))
  })
  // One reply per check-in. Someone else's check-in looks exactly like a missing one (404).
  .post('/checkins/:id/reply', requireRole('caregiver'), small, idParam, valid('json', z.object({ text: z.string().trim().min(1).max(1000) })), (c) => {
    const u = currentUser(c)!
    const changed = db.prepare(`UPDATE checkins SET reply_text = :text, reply_at = ${NOW}
      WHERE id = :id AND reply_at IS NULL AND event_id IN (
        SELECT e.id FROM outage_events e JOIN patients p ON p.id = e.patient_id WHERE ${OPEN} AND e.mode = :mode AND ${SEES})`)
      .run({ id: c.req.valid('param').id, text: c.req.valid('json').text, uid: u.id, orgId: u.orgId, mode: setting('mode') }).changes
    if (!changed) return c.json(withFeed({ error: 'Aviso no encontrado o ya contestado' }), 404)
    return c.json(withFeed({ id: c.req.valid('param').id }))
  })

  // Coordinator: the first organization to claim wins; the database decides the race inside claimEvent.
  .post('/events/:id/claim', requireRole('coordinator'), idParam, (c) => {
    const u = currentUser(c)!
    const { id } = c.req.valid('param')
    if (!eventFor(u, id) || u.orgId === null) return c.json(withFeed({ error: 'Caso no encontrado' }), 404)
    const won = claimEvent(id, u.orgId, u.id)
    const ev = eventFor(u, id)!
    if (won || ev.claimedByOrgId === u.orgId) return c.json(withFeed({ id, claimedBy: ev.claimedBy }))
    return c.json(withFeed({ error: ev.claimedBy ? `Atendido por ${ev.claimedBy}` : 'El caso ya está cerrado', claimedBy: ev.claimedBy }), 409)
  })
  .get('/events/:id', requireRole('coordinator', 'admin'), idParam, (c) => {
    const u = currentUser(c)!
    const ev = eventFor(u, c.req.valid('param').id)
    if (!ev) return c.json(withFeed({ error: 'Caso no encontrado' }), 404)
    const checkin = db.prepare(`SELECT id, message, sent_at AS sentAt, reply_text AS replyText, reply_at AS replyAt, ai_parsed AS aiParsed, confirmed_at AS confirmedAt
      FROM checkins WHERE event_id = ? ORDER BY id DESC LIMIT 1`).get(ev.id) as Checkin | undefined
    const outcomes = db.prepare(`SELECT co.id, co.reached, co.outcome, co.next_action AS nextAction, co.created_at AS createdAt, us.name AS coordinator
      FROM call_outcomes co JOIN users us ON us.id = co.coordinator_id WHERE co.event_id = ? ORDER BY co.id`).all(ev.id) as Outcome[]
    return c.json(withFeed({
      event: { ...ev, needs: JSON.parse(ev.needs) as Need[], mine: ev.claimedByOrgId !== null && ev.claimedByOrgId === u.orgId },
      checkin: checkin ?? null,
      outcomes: outcomes.map((o) => ({ ...o, reached: !!o.reached })),
    }))
  })
  // The human step after a reply: the coordinator reads the original text and says what it means.
  .post('/checkins/:id/confirm', requireRole('coordinator'), idParam, valid('json', z.object({ hasPower: z.boolean() })), (c) => {
    const u = currentUser(c)!
    const row = db.prepare(`SELECT c.id, c.reply_text AS replyText, e.id AS eventId, e.status
      FROM checkins c JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
      WHERE c.id = :id AND e.mode = :mode AND ${COVERS}`).get({ id: c.req.valid('param').id, ...scope(u) }) as
      { id: number; replyText: string | null; eventId: number; status: EventRow['status'] } | undefined
    if (!row) return c.json(withFeed({ error: 'Aviso no encontrado' }), 404)
    if (row.replyText === null) return c.json(withFeed({ error: 'Todavía no hay respuesta que confirmar' }), 409)
    const status = !c.req.valid('json').hasPower ? 'confirmed' : row.status === 'confirmed' ? 'restored' : 'false_alarm'
    if (!setEventStatus(row.eventId, status)) return c.json(withFeed({ error: 'El caso ya está cerrado' }), 409)
    db.prepare(`UPDATE checkins SET confirmed_by = ?, confirmed_at = ${NOW} WHERE id = ?`).run(u.id, row.id)
    return c.json(withFeed({ eventId: row.eventId, status }))
  })
  // Only the organization that claimed the event records what happened on the call.
  .post('/events/:id/outcome', requireRole('coordinator'), small, idParam,
    valid('json', z.object({ reached: z.boolean(), outcome: z.string().trim().min(1).max(500), nextAction: z.string().trim().max(500).default('') })), (c) => {
      const u = currentUser(c)!
      const ev = eventFor(u, c.req.valid('param').id)
      if (!ev) return c.json(withFeed({ error: 'Caso no encontrado' }), 404)
      if (ev.claimedByOrgId === null || ev.claimedByOrgId !== u.orgId)
        return c.json(withFeed({ error: 'Solo la organización que tomó el caso puede registrar el resultado' }), 403)
      const b = c.req.valid('json')
      const id = Number(db.prepare('INSERT INTO call_outcomes (event_id, coordinator_id, reached, outcome, next_action) VALUES (?, ?, ?, ?, ?)')
        .run(ev.id, u.id, b.reached ? 1 : 0, b.outcome, b.nextAction || null).lastInsertRowid)
      return c.json(withFeed({ id }), 201)
    })
