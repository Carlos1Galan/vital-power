import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { COOKIE, currentUser, persona, personas, requireRole, type CurrentUser } from './auth.ts'
import { db, setting } from './db.ts'
import { callList, claimEvent, feedStatus, knownZones, setEventStatus } from './events.ts'
import { MUNICIPALITIES } from './municipalities.ts'
import type { NeedKind } from './priority.ts'
import { ReplyReading, draftBriefing, extractProfile, readReply } from './ai.ts'
import { readFileSync } from 'node:fs'

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

const tx = <T>(fn: () => T) => {
  db.exec('BEGIN')
  try { const out = fn(); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e }
}
const zoneCatalogue = () => {
  const out: Record<string, string[]> = {}
  for (const z of db.prepare('SELECT municipality, zone FROM zones ORDER BY municipality, zone').all() as { municipality: string; zone: string }[])
    (out[z.municipality] ??= []).push(z.zone)
  return out
}
// What the caregiver confirmed on the review screen. The AI draft never reaches the patients table by itself.
const PatientBody = z.object({
  intakeId: z.number().int().positive().optional(),
  isSelf: z.boolean(),
  consent: z.literal(true),
  profile: z.object({
    displayName: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(30).default(''),
    municipality: z.enum(MUNICIPALITIES),
    zone: z.string().trim().min(1).max(120).nullable(),
    needs: z.array(z.object({ kind: z.enum(['oxygen', 'cpap', 'ventilator', 'dialysis', 'insulin', 'other']), batteryHours: z.number().min(0).max(240).nullable() })).min(1).max(6),
  }),
})
const reading = (json: string | null) => {
  if (!json) return null
  try { return ReplyReading.parse(JSON.parse(json)) } catch { return null }
}
// Each AI draft costs money and seconds: a small per-user budget stops a stuck button or a script from running up calls.
const AI_PER_MINUTE = 20
const aiCalls = new Map<number, number[]>()
const aiBudget: MiddlewareHandler = async (c, next) => {
  const u = currentUser(c)
  if (u) {
    const recent = (aiCalls.get(u.id) ?? []).filter((t) => Date.now() - t < 60_000)
    if (recent.length >= AI_PER_MINUTE) return c.json(withFeed({ error: 'Demasiadas solicitudes seguidas. Espere un minuto.' }), 429)
    aiCalls.set(u.id, [...recent, Date.now()])
  }
  await next()
}
const BriefingBody = z.object({ text: z.string().trim().min(1).max(4000).optional(), lang: z.enum(['es', 'en']).default('es') })
const NOT_CLAIMED = 'Solo la organización que tomó el caso puede hacer esto'

// What seed.sql ships: the highest seeded id of each table, and each seeded organization's status.
// Read from the file itself so the reset keeps working when the seed changes.
const seeded = (() => {
  const sql = readFileSync(new URL('seed.sql', import.meta.url), 'utf8')
  const rows = (table: string) => (new RegExp(`INSERT INTO ${table} [^;]*VALUES([^;]*);`).exec(sql)?.[1] ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('('))
  const maxId = (table: string) => Math.max(0, ...rows(table).map((r) => Number(/^\((\d+)/.exec(r)?.[1] ?? 0)))
  const orgStatus = rows('organizations').map((r) => [Number(/^\((\d+)/.exec(r)?.[1]), /'(pending|approved|rejected)'\s*\)/.exec(r)?.[1] ?? 'pending'] as const)
  return { patients: maxId('patients'), organizations: maxId('organizations'), orgStatus }
})()

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
        e.status AS outage, o.name AS claimedBy,
        (SELECT json_object('reached', co.reached, 'outcome', co.outcome, 'nextAction', co.next_action, 'createdAt', co.created_at)
           FROM call_outcomes co WHERE co.event_id = e.id ORDER BY co.id DESC LIMIT 1) AS lastCall
      FROM patients p
      LEFT JOIN outage_events e ON e.patient_id = p.id AND e.mode = :mode AND ${OPEN}
      LEFT JOIN organizations o ON o.id = e.claimed_by_org_id
      WHERE ${SEES} ORDER BY p.id`).all({ uid: u.id, orgId: u.orgId, mode: setting('mode') }) as
      { id: number; name: string; municipality: string; zone: string | null; isSelf: number; needs: string; outage: 'possible' | 'confirmed' | null; claimedBy: string | null; lastCall: string | null }[]
    // What the family is told about the response: which organization took the case and the result of the last call.
    type LastCall = { reached: number; outcome: string; nextAction: string | null; createdAt: string }
    return c.json(withFeed({ patients: rows.map((p) => {
      const call = p.lastCall ? JSON.parse(p.lastCall) as LastCall : null
      return { ...p, isSelf: !!p.isSelf, needs: JSON.parse(p.needs) as Need[], lastCall: call && { ...call, reached: !!call.reached } }
    }) }))
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
    // The reply is already saved. The AI reading is a convenience for the coordinator and can take seconds,
    // so it runs after the response: the caregiver never waits on it and its failure loses nothing.
    const { id } = c.req.valid('param')
    const saved = db.prepare('SELECT message, reply_text AS replyText FROM checkins WHERE id = ?').get(id) as { message: string; replyText: string }
    void readReply(saved.message, saved.replyText)
      .then((r) => db.prepare('UPDATE checkins SET ai_parsed = ? WHERE id = ?').run(JSON.stringify(r), id))
      .catch((e) => console.error('readReply failed', e))
    return c.json(withFeed({ id }))
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
    const briefing = db.prepare(`SELECT id, draft_text AS draftText, approved_text AS approvedText, approved_at AS approvedAt
      FROM briefings WHERE event_id = ? ORDER BY id DESC LIMIT 1`).get(ev.id) as { id: number; draftText: string; approvedText: string | null; approvedAt: string | null } | undefined
    return c.json(withFeed({
      event: { ...ev, needs: JSON.parse(ev.needs) as Need[], mine: ev.claimedByOrgId !== null && ev.claimedByOrgId === u.orgId },
      checkin: checkin ? { ...checkin, aiParsed: reading(checkin.aiParsed) } : null,
      briefing: briefing ?? null,
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

  // Intake: the AI drafts a profile from what the caregiver said. Nothing becomes a patient until POST /patients.
  .get('/zones/:municipality', requireRole('caregiver'), valid('param', z.object({ municipality: z.enum(MUNICIPALITIES) })), (c) =>
    c.json(withFeed({ zones: knownZones(c.req.valid('param').municipality) })))
  .post('/intake/extract', requireRole('caregiver'), aiBudget, small, valid('json', z.object({ transcript: z.string().trim().min(3).max(4000) })), async (c) => {
    const u = currentUser(c)!
    const { transcript } = c.req.valid('json')
    try {
      const draft = await extractProfile(transcript, zoneCatalogue())
      // AI zone matching must return one of knownZones(municipality) or null; enforced here, not trusted from the model.
      const zones = draft.municipality ? knownZones(draft.municipality) : []
      const profile = { ...draft, zone: draft.zone !== null && zones.includes(draft.zone) ? draft.zone : null }
      const intakeId = Number(db.prepare('INSERT INTO intakes (caregiver_id, transcript, ai_json) VALUES (?, ?, ?)').run(u.id, transcript, JSON.stringify(profile)).lastInsertRowid)
      return c.json(withFeed({ intakeId, profile, zones }))
    } catch (e) {
      console.error('extractProfile failed', e)
      return c.json(withFeed({ error: 'No se pudo leer el relato automáticamente. Llene los datos a mano.' }), 502)
    }
  })
  .post('/patients', requireRole('caregiver'), small, valid('json', PatientBody), (c) => {
    const u = currentUser(c)!
    const { intakeId, isSelf, profile: p } = c.req.valid('json')
    if (p.zone !== null && !knownZones(p.municipality).includes(p.zone)) return c.json(withFeed({ error: 'Entrada inválida: profile.zone' }), 400)
    if (isSelf && db.prepare('SELECT 1 FROM patients WHERE caregiver_id = ? AND is_self = 1').get(u.id)) return c.json(withFeed({ error: 'Usted ya tiene su propio registro' }), 409)
    const id = tx(() => {
      // facility_id comes from the current user, never from the request body.
      const patientId = Number(db.prepare(`INSERT INTO patients (caregiver_id, facility_id, is_self, display_name, phone, municipality, zone, consent_at, consent_version, confirmed_at)
        VALUES (:uid, (SELECT id FROM organizations WHERE id = :orgId AND kind = 'facility'), :isSelf, :name, :phone, :municipality, :zone, ${NOW}, 'v1', ${NOW})`)
        .run({ uid: u.id, orgId: u.orgId, isSelf: isSelf ? 1 : 0, name: p.displayName, phone: p.phone || null, municipality: p.municipality, zone: p.zone }).lastInsertRowid)
      const need = db.prepare('INSERT INTO patient_needs (patient_id, kind, battery_hours) VALUES (?, ?, ?)')
      for (const n of p.needs) need.run(patientId, n.kind, n.batteryHours)
      if (intakeId) db.prepare("UPDATE intakes SET status = 'confirmed', patient_id = ? WHERE id = ? AND caregiver_id = ? AND status = 'draft'").run(patientId, intakeId, u.id)
      return patientId
    })
    return c.json(withFeed({ id }), 201)
  })

  // Briefing: an AI draft for the organization that claimed the event; a coordinator edits and approves it before use.
  .post('/events/:id/briefing', requireRole('coordinator'), aiBudget, small, idParam, valid('json', BriefingBody), async (c) => {
    const u = currentUser(c)!
    const ev = eventFor(u, c.req.valid('param').id)
    if (!ev) return c.json(withFeed({ error: 'Caso no encontrado' }), 404)
    if (ev.claimedByOrgId === null || ev.claimedByOrgId !== u.orgId) return c.json(withFeed({ error: NOT_CLAIMED }), 403)
    const { text, lang } = c.req.valid('json')
    if (text) { // written by the coordinator: no AI involved, and it still needs the approve step
      const id = Number(db.prepare('INSERT INTO briefings (event_id, draft_text) VALUES (?, ?)').run(ev.id, text).lastInsertRowid)
      return c.json(withFeed({ id, draftText: text }), 201)
    }
    const reply = db.prepare('SELECT reply_text AS replyText FROM checkins WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(ev.id) as { replyText: string | null } | undefined
    const reasons = callList(u).find((e) => e.eventId === ev.id)?.reasons ?? [] // the fixed rules explain the position; the AI only words it
    try {
      const draft = await draftBriefing({ patientName: ev.patientName, municipality: ev.municipality, zone: ev.zone, status: ev.status,
        needs: JSON.parse(ev.needs) as Need[], reasons, reply: reply?.replyText ?? null }, lang)
      const draftText = `${draft.briefing}\n\n${lang === 'en' ? 'Call script' : 'Guion de llamada'}:\n${draft.callScript}`
      const id = Number(db.prepare('INSERT INTO briefings (event_id, draft_text) VALUES (?, ?)').run(ev.id, draftText).lastInsertRowid)
      return c.json(withFeed({ id, draftText }), 201)
    } catch (e) {
      console.error('draftBriefing failed', e)
      return c.json(withFeed({ error: 'No se pudo redactar el resumen automáticamente. Intente de nuevo.' }), 502)
    }
  })
  .post('/briefings/:id/approve', requireRole('coordinator'), small, idParam, valid('json', z.object({ text: z.string().trim().min(1).max(4000) })), (c) => {
    const u = currentUser(c)!
    const row = db.prepare(`SELECT b.id, e.claimed_by_org_id AS claimedByOrgId FROM briefings b JOIN outage_events e ON e.id = b.event_id JOIN patients p ON p.id = e.patient_id
      WHERE b.id = :id AND e.mode = :mode AND ${COVERS}`).get({ id: c.req.valid('param').id, ...scope(u) }) as { id: number; claimedByOrgId: number | null } | undefined
    if (!row) return c.json(withFeed({ error: 'Resumen no encontrado' }), 404)
    if (row.claimedByOrgId === null || row.claimedByOrgId !== u.orgId) return c.json(withFeed({ error: NOT_CLAIMED }), 403)
    db.prepare(`UPDATE briefings SET approved_text = ?, approved_by = ?, approved_at = ${NOW} WHERE id = ?`).run(c.req.valid('json').text, u.id, row.id)
    return c.json(withFeed({ id: row.id }))
  })

  // Rehearsal reset (admin): back to the seeded patients and organizations, live mode, no cases in progress.
  // Recorded LUMA readings are never touched: the replay depends on them.
  .post('/demo/reset', requireRole('admin'), (c) => {
    tx(() => {
      db.exec(`DELETE FROM briefings; DELETE FROM call_outcomes; DELETE FROM intakes;
        DELETE FROM checkins WHERE event_id IN (SELECT id FROM outage_events WHERE mode = 'replay' OR patient_id > ${seeded.patients});
        DELETE FROM outage_events WHERE mode = 'replay' OR patient_id > ${seeded.patients};
        DELETE FROM patient_needs WHERE patient_id > ${seeded.patients};
        DELETE FROM patients WHERE id > ${seeded.patients};
        DELETE FROM org_municipalities WHERE org_id > ${seeded.organizations};
        DELETE FROM organizations WHERE id > ${seeded.organizations};
        UPDATE checkins SET reply_text = NULL, reply_at = NULL, ai_parsed = NULL, confirmed_by = NULL, confirmed_at = NULL;
        UPDATE outage_events SET claimed_by_org_id = NULL, claimed_by = NULL, claimed_at = NULL,
          status = CASE WHEN status = 'confirmed' THEN 'possible' ELSE status END;
        UPDATE settings SET value = 'live' WHERE key = 'mode'`)
      const status = db.prepare('UPDATE organizations SET status = ?, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?')
      for (const [id, value] of seeded.orgStatus) status.run(value, id)
    })
    return c.json(withFeed({ patients: seeded.patients }))
  })
