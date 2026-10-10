import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { deleteCookie, setCookie } from 'hono/cookie'
import { HTTPException } from 'hono/http-exception'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { COOKIE, currentUser, persona, personas, requireRole, type CurrentUser } from './auth.ts'
import { db, setting } from './db.ts'
import { NEEDS, callList, claimEvent, feedStatus, knownZones, setEventStatus } from './events.ts'
import { MUNICIPALITIES } from './municipalities.ts'
import type { NeedKind } from './priority.ts'
import { ReplyReading, draftBriefing, extractProfile, readReplyLater } from './ai.ts'
import { send, waNumber, whatsappOn } from './whatsapp.ts'
import { readFileSync } from 'node:fs'

const withFeed = async <T extends object>(data: T) => ({ ...await feedStatus(), ...data })
const valid = <T extends 'json' | 'param', S extends z.ZodType>(target: T, schema: S) =>
  zValidator(target, schema, async (r, c) => {
    if (!r.success) return c.json(await withFeed({ error: `Entrada inválida: ${r.error.issues.map((i) => i.path.join('.') || i.message).join(', ')}` }), 400)
  })
const small = bodyLimit({ maxSize: 16 * 1024, onError: async (c) => c.json(await withFeed({ error: 'Texto demasiado largo' }), 413) })
const idParam = valid('param', z.object({ id: z.coerce.number().int().positive() }))
const NOW = 'iso(now())'
const OPEN = "e.status IN ('possible','confirmed')"

// Visibility lives in the SQL, never in the UI.
// A caregiver sees the patients they registered plus their facility's (facility_id = NULL matches nothing).
const SEES = '(p.caregiver_id = :uid OR p.facility_id = :orgId)'
// A coordinator acts only in the municipalities of its approved organization; admin sees every municipality.
const COVERS = `(:all = 1 OR p.municipality IN (SELECT om.municipality FROM org_municipalities om JOIN organizations o ON o.id = om.org_id
  WHERE o.id = :orgId AND o.kind = 'responder' AND o.status = 'approved'))`
const scope = async (u: CurrentUser) => ({ all: u.role === 'admin' ? 1 : 0, orgId: u.orgId, mode: await setting('mode') })

type Need = { kind: NeedKind; batteryHours: number | null }
type EventRow = {
  id: number; status: 'possible' | 'confirmed' | 'restored' | 'false_alarm'; openedAt: string; closedAt: string | null
  claimedByOrgId: number | null; claimedBy: string | null; claimedAt: string | null
  patientName: string; phone: string | null; municipality: string; zone: string | null; needs: string
  lat: number | null; lng: number | null; locationAccuracyM: number | null
}
// An event of the current mode that this coordinator (or admin) may see; undefined otherwise.
const eventFor = async (u: CurrentUser, id: number) =>
  await db.prepare(`SELECT e.id, e.status, e.opened_at AS openedAt, e.closed_at AS closedAt,
      e.claimed_by_org_id AS claimedByOrgId, o.name AS claimedBy, e.claimed_at AS claimedAt,
      p.display_name AS patientName, p.phone, p.municipality, p.zone, ${NEEDS} AS needs,
      p.lat, p.lng, p.location_accuracy_m AS locationAccuracyM
    FROM outage_events e JOIN patients p ON p.id = e.patient_id LEFT JOIN organizations o ON o.id = e.claimed_by_org_id
    WHERE e.id = :id AND e.mode = :mode AND ${COVERS}`).get({ id, ...await scope(u) }) as EventRow | undefined

const zoneCatalogue = async () => {
  const out: Record<string, string[]> = {}
  for (const z of await db.prepare('SELECT municipality, zone FROM zones ORDER BY municipality, zone').all() as { municipality: string; zone: string }[])
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
    // Only when the caregiver pressed "share my exact location" and the browser allowed it. Bounds: Puerto Rico, Vieques, Culebra and Mona.
    location: z.object({ lat: z.number().min(17.8).max(18.6), lng: z.number().min(-68).max(-65.2), accuracyM: z.number().min(0).max(100_000) }).nullable().default(null),
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
  const u = await currentUser(c)
  if (u) {
    const recent = (aiCalls.get(u.id) ?? []).filter((t) => Date.now() - t < 60_000)
    if (recent.length >= AI_PER_MINUTE) return c.json(await withFeed({ error: 'Demasiadas solicitudes seguidas. Espere un minuto.' }), 429)
    aiCalls.set(u.id, [...recent, Date.now()])
  }
  await next()
}
const BriefingBody = z.object({ text: z.string().trim().min(1).max(4000).optional(), lang: z.enum(['es', 'en']).default('es') })
const MAX_SIGNUPS = 50
const NOT_CLAIMED = 'Solo la organización que tomó el caso puede hacer esto'

// What seed.sql ships: the highest seeded id of each table, and each seeded organization's status.
// Read from the file itself so the reset keeps working when the seed changes.
const seeded = (() => {
  const sql = readFileSync(new URL('seed.sql', import.meta.url), 'utf8')
  const rows = (table: string) => (new RegExp(`INSERT INTO ${table} [^;]*VALUES([^;]*);`).exec(sql)?.[1] ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('('))
  const maxId = (table: string) => Math.max(0, ...rows(table).map((r) => Number(/^\((\d+)/.exec(r)?.[1] ?? 0)))
  const orgStatus = rows('organizations').map((r) => [Number(/^\((\d+)/.exec(r)?.[1]), /'(pending|approved|rejected)'\s*\)/.exec(r)?.[1] ?? 'pending'] as const)
  return { patients: maxId('patients'), organizations: maxId('organizations'), users: maxId('users'), orgStatus }
})()

type Checkin = { id: number; message: string; sentAt: string; replyText: string | null; replyAt: string | null; aiParsed: string | null; confirmedAt: string | null }
type Outcome = { id: number; reached: number; outcome: string; nextAction: string | null; createdAt: string; coordinator: string }
type Message = { id: number; dir: 'out' | 'in'; body: string; error: string | null; createdAt: string; sentBy: string | null }

// Owned by B: demo login, intake, patients, check-ins, claim, events, briefings, outcomes.
export const appRoutes = new Hono()
  .onError(async (error, c) => {
    const bad = error instanceof HTTPException && error.status === 400 // malformed JSON body
    if (!bad) console.error(error)
    return c.json(await withFeed({ error: bad ? 'Entrada inválida' : 'Error del API' }), bad ? 400 : 500)
  })
  .get('/demo/personas', async (c) => c.json(await withFeed({ personas: await personas() })))
  .post('/demo/login', valid('json', z.object({ userId: z.number().int().positive() })), async (c) => {
    const user = await persona(c.req.valid('json').userId)
    if (!user) return c.json(await withFeed({ error: 'Persona no encontrada' }), 404)
    setCookie(c, COOKIE, String(user.id), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 7 })
    return c.json(await withFeed({ user }))
  })
  // Caregiver sign-up, demo style: a name creates a caregiver persona and signs it in. No password, synthetic data only.
  .post('/demo/caregivers', small, valid('json', z.object({ name: z.string().trim().min(2).max(80) })), async (c) => {
    // A ceiling keeps a stuck form or a script from filling the persona list.
    if ((await db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n >= seeded.users + MAX_SIGNUPS)
      return c.json(await withFeed({ error: 'Hay demasiados perfiles de demostración. Pida a un administrador que reinicie la demostración.' }), 429)
    const { id } = await db.prepare("INSERT INTO users (name, role, org_id) VALUES (?, 'caregiver', NULL) RETURNING id").get(c.req.valid('json').name) as { id: number }
    setCookie(c, COOKIE, String(id), { path: '/', httpOnly: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 7 })
    return c.json(await withFeed({ user: (await persona(id))! }), 201)
  })
  .post('/demo/logout', async (c) => {
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json(await withFeed({ user: null }))
  })
  .get('/demo/me', async (c) => {
    const user = await currentUser(c)
    return c.json(await withFeed({ user: user ? await persona(user.id) : null }))
  })

  // Caregiver: own patients plus the facility's, each with its open outage (if any) in the current mode.
  .get('/patients/mine', requireRole('caregiver'), async (c) => {
    const u = (await currentUser(c))!
    const rows = await db.prepare(`SELECT p.id, p.display_name AS name, p.municipality, p.zone, p.is_self AS isSelf, ${NEEDS} AS needs,
        e.status AS outage, o.name AS claimedBy,
        (SELECT c.reply_at IS NOT NULL FROM checkins c WHERE c.event_id = e.id ORDER BY c.id DESC LIMIT 1) AS answered,
        (SELECT json_build_object('reached', co.reached, 'outcome', co.outcome, 'nextAction', co.next_action, 'createdAt', co.created_at)::text
           FROM call_outcomes co WHERE co.event_id = e.id ORDER BY co.id DESC LIMIT 1) AS lastCall
      FROM patients p
      LEFT JOIN outage_events e ON e.patient_id = p.id AND e.mode = :mode AND ${OPEN}
      LEFT JOIN organizations o ON o.id = e.claimed_by_org_id
      WHERE ${SEES} ORDER BY p.id`).all({ uid: u.id, orgId: u.orgId, mode: await setting('mode') }) as
      { id: number; name: string; municipality: string; zone: string | null; isSelf: number; needs: string; outage: 'possible' | 'confirmed' | null; claimedBy: string | null; answered: boolean | null; lastCall: string | null }[]
    // What the family is told about the response: which organization took the case and the result of the last call.
    type LastCall = { reached: number; outcome: string; nextAction: string | null; createdAt: string }
    return c.json(await withFeed({ patients: rows.map((p) => {
      const call = p.lastCall ? JSON.parse(p.lastCall) as LastCall : null
      return { ...p, isSelf: !!p.isSelf, answered: !!p.answered, needs: JSON.parse(p.needs) as Need[], lastCall: call && { ...call, reached: !!call.reached } }
    }) }))
  })
  .get('/checkins/pending', requireRole('caregiver'), async (c) => {
    const u = (await currentUser(c))!
    const checkins = await db.prepare(`SELECT c.id, c.message, c.sent_at AS sentAt, p.id AS patientId, p.display_name AS patientName
      FROM checkins c JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
      WHERE c.reply_at IS NULL AND ${OPEN} AND e.mode = :mode AND ${SEES} ORDER BY c.id`).all({ uid: u.id, orgId: u.orgId, mode: await setting('mode') }) as
      { id: number; message: string; sentAt: string; patientId: number; patientName: string }[]
    return c.json(await withFeed({ checkins }))
  })
  // One reply per check-in. Someone else's check-in looks exactly like a missing one (404).
  .post('/checkins/:id/reply', requireRole('caregiver'), small, idParam, valid('json', z.object({ text: z.string().trim().min(1).max(1000) })), async (c) => {
    const u = (await currentUser(c))!
    const { changes } = await db.prepare(`UPDATE checkins SET reply_text = :text, reply_at = ${NOW}
      WHERE id = :id AND reply_at IS NULL AND event_id IN (
        SELECT e.id FROM outage_events e JOIN patients p ON p.id = e.patient_id WHERE ${OPEN} AND e.mode = :mode AND ${SEES})`)
      .run({ id: c.req.valid('param').id, text: c.req.valid('json').text, uid: u.id, orgId: u.orgId, mode: await setting('mode') })
    if (!changes) return c.json(await withFeed({ error: 'Aviso no encontrado o ya contestado' }), 404)
    const { id } = c.req.valid('param')
    readReplyLater(id)
    return c.json(await withFeed({ id }))
  })

  // Coordinator: the first organization to claim wins; the database decides the race inside claimEvent.
  .post('/events/:id/claim', requireRole('coordinator'), idParam, async (c) => {
    const u = (await currentUser(c))!
    const { id } = c.req.valid('param')
    if (!await eventFor(u, id) || u.orgId === null) return c.json(await withFeed({ error: 'Caso no encontrado' }), 404)
    const won = await claimEvent(id, u.orgId, u.id)
    const ev = (await eventFor(u, id))!
    if (won || ev.claimedByOrgId === u.orgId) return c.json(await withFeed({ id, claimedBy: ev.claimedBy }))
    return c.json(await withFeed({ error: ev.claimedBy ? `Atendido por ${ev.claimedBy}` : 'El caso ya está cerrado', claimedBy: ev.claimedBy }), 409)
  })
  .get('/events/:id', requireRole('coordinator', 'admin'), idParam, async (c) => {
    const u = (await currentUser(c))!
    const ev = await eventFor(u, c.req.valid('param').id)
    if (!ev) return c.json(await withFeed({ error: 'Caso no encontrado' }), 404)
    const checkin = await db.prepare(`SELECT id, message, sent_at AS sentAt, reply_text AS replyText, reply_at AS replyAt, ai_parsed AS aiParsed, confirmed_at AS confirmedAt
      FROM checkins WHERE event_id = ? ORDER BY id DESC LIMIT 1`).get(ev.id) as Checkin | undefined
    const outcomes = await db.prepare(`SELECT co.id, co.reached, co.outcome, co.next_action AS nextAction, co.created_at AS createdAt, us.name AS coordinator
      FROM call_outcomes co JOIN users us ON us.id = co.coordinator_id WHERE co.event_id = ? ORDER BY co.id`).all(ev.id) as Outcome[]
    const briefing = await db.prepare(`SELECT id, draft_text AS draftText, approved_text AS approvedText, approved_at AS approvedAt
      FROM briefings WHERE event_id = ? ORDER BY id DESC LIMIT 1`).get(ev.id) as { id: number; draftText: string; approvedText: string | null; approvedAt: string | null } | undefined
    const messages = await db.prepare(`SELECT m.id, m.dir, m.body, m.error, m.created_at AS createdAt, us.name AS sentBy
      FROM messages m LEFT JOIN users us ON us.id = m.sent_by WHERE m.event_id = ? ORDER BY m.id`).all(ev.id) as Message[]
    return c.json(await withFeed({
      event: { ...ev, needs: JSON.parse(ev.needs) as Need[], mine: ev.claimedByOrgId !== null && ev.claimedByOrgId === u.orgId },
      whatsapp: whatsappOn(),
      messages,
      checkin: checkin ? { ...checkin, aiParsed: reading(checkin.aiParsed) } : null,
      briefing: briefing ?? null,
      outcomes: outcomes.map((o) => ({ ...o, reached: !!o.reached })),
    }))
  })
  // The human step after a reply: the coordinator reads the original text and says what it means.
  .post('/checkins/:id/confirm', requireRole('coordinator'), idParam, valid('json', z.object({ hasPower: z.boolean() })), async (c) => {
    const u = (await currentUser(c))!
    const row = await db.prepare(`SELECT c.id, c.reply_text AS replyText, e.id AS eventId, e.status
      FROM checkins c JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
      WHERE c.id = :id AND e.mode = :mode AND ${COVERS}`).get({ id: c.req.valid('param').id, ...await scope(u) }) as
      { id: number; replyText: string | null; eventId: number; status: EventRow['status'] } | undefined
    if (!row) return c.json(await withFeed({ error: 'Aviso no encontrado' }), 404)
    if (row.replyText === null) return c.json(await withFeed({ error: 'Todavía no hay respuesta que confirmar' }), 409)
    const status = !c.req.valid('json').hasPower ? 'confirmed' : row.status === 'confirmed' ? 'restored' : 'false_alarm'
    if (!await setEventStatus(row.eventId, status)) return c.json(await withFeed({ error: 'El caso ya está cerrado' }), 409)
    await db.prepare(`UPDATE checkins SET confirmed_by = ?, confirmed_at = ${NOW} WHERE id = ?`).run(u.id, row.id)
    return c.json(await withFeed({ eventId: row.eventId, status }))
  })
  // Only the organization that claimed the event records what happened on the call.
  .post('/events/:id/outcome', requireRole('coordinator'), small, idParam,
    valid('json', z.object({ reached: z.boolean(), outcome: z.string().trim().min(1).max(500), nextAction: z.string().trim().max(500).default('') })), async (c) => {
      const u = (await currentUser(c))!
      const ev = await eventFor(u, c.req.valid('param').id)
      if (!ev) return c.json(await withFeed({ error: 'Caso no encontrado' }), 404)
      if (ev.claimedByOrgId === null || ev.claimedByOrgId !== u.orgId)
        return c.json(await withFeed({ error: 'Solo la organización que tomó el caso puede registrar el resultado' }), 403)
      const b = c.req.valid('json')
      const { id } = await db.prepare('INSERT INTO call_outcomes (event_id, coordinator_id, reached, outcome, next_action) VALUES (?, ?, ?, ?, ?) RETURNING id')
        .get(ev.id, u.id, b.reached ? 1 : 0, b.outcome, b.nextAction || null) as { id: number }
      return c.json(await withFeed({ id }), 201)
    })

  // WhatsApp chat with the patient or caregiver: a coordinator of the organization that claimed the case writes every word.
  .post('/events/:id/messages', requireRole('coordinator'), small, idParam, valid('json', z.object({ text: z.string().trim().min(1).max(1000) })), async (c) => {
    const u = (await currentUser(c))!
    const ev = await eventFor(u, c.req.valid('param').id)
    if (!ev) return c.json(await withFeed({ error: 'Caso no encontrado' }), 404)
    if (ev.claimedByOrgId === null || ev.claimedByOrgId !== u.orgId) return c.json(await withFeed({ error: NOT_CLAIMED }), 403)
    if (ev.status !== 'possible' && ev.status !== 'confirmed') return c.json(await withFeed({ error: 'El caso ya está cerrado' }), 409)
    if (!whatsappOn()) return c.json(await withFeed({ error: 'WhatsApp no está configurado' }), 503)
    const phone = waNumber(ev.phone)
    if (!phone) return c.json(await withFeed({ error: 'El paciente no tiene teléfono para WhatsApp' }), 409)
    const error = await send({ eventId: ev.id, phone, body: c.req.valid('json').text, sentBy: u.id })
    if (error) return c.json(await withFeed({ error: `WhatsApp no aceptó el mensaje: ${error}` }), 502)
    return c.json(await withFeed({ eventId: ev.id }), 201)
  })

  // Intake: the AI drafts a profile from what the caregiver said. Nothing becomes a patient until POST /patients.
  .get('/zones/:municipality', requireRole('caregiver'), valid('param', z.object({ municipality: z.enum(MUNICIPALITIES) })), async (c) =>
    c.json(await withFeed({ zones: await knownZones(c.req.valid('param').municipality) })))
  .post('/intake/extract', requireRole('caregiver'), aiBudget, small, valid('json', z.object({ transcript: z.string().trim().min(3).max(4000) })), async (c) => {
    const u = (await currentUser(c))!
    const { transcript } = c.req.valid('json')
    try {
      const draft = await extractProfile(transcript, await zoneCatalogue())
      // AI zone matching must return one of knownZones(municipality) or null; enforced here, not trusted from the model.
      const zones = draft.municipality ? await knownZones(draft.municipality) : []
      const profile = { ...draft, zone: draft.zone !== null && zones.includes(draft.zone) ? draft.zone : null }
      const { id: intakeId } = await db.prepare('INSERT INTO intakes (caregiver_id, transcript, ai_json) VALUES (?, ?, ?) RETURNING id').get(u.id, transcript, JSON.stringify(profile)) as { id: number }
      return c.json(await withFeed({ intakeId, profile, zones }))
    } catch (e) {
      console.error('extractProfile failed', e)
      return c.json(await withFeed({ error: 'No se pudo leer el relato automáticamente. Llene los datos a mano.' }), 502)
    }
  })
  .post('/patients', requireRole('caregiver'), small, valid('json', PatientBody), async (c) => {
    const u = (await currentUser(c))!
    const { intakeId, isSelf, profile: p } = c.req.valid('json')
    if (p.zone !== null && !(await knownZones(p.municipality)).includes(p.zone)) return c.json(await withFeed({ error: 'Entrada inválida: profile.zone' }), 400)
    if (isSelf && await db.prepare('SELECT 1 FROM patients WHERE caregiver_id = ? AND is_self = 1').get(u.id)) return c.json(await withFeed({ error: 'Usted ya tiene su propio registro' }), 409)
    const id = await db.tx(async () => {
      // facility_id comes from the current user, never from the request body.
      const { id: patientId } = await db.prepare(`INSERT INTO patients (caregiver_id, facility_id, is_self, display_name, phone, municipality, zone, lat, lng, location_accuracy_m, consent_at, consent_version, confirmed_at)
        VALUES (:uid, (SELECT id FROM organizations WHERE id = :orgId AND kind = 'facility'), :isSelf, :name, :phone, :municipality, :zone, :lat, :lng, :accuracy, ${NOW}, 'v1', ${NOW}) RETURNING id`)
        .get({ uid: u.id, orgId: u.orgId, isSelf: isSelf ? 1 : 0, name: p.displayName, phone: p.phone || null, municipality: p.municipality, zone: p.zone,
          lat: p.location?.lat ?? null, lng: p.location?.lng ?? null, accuracy: p.location?.accuracyM ?? null }) as { id: number }
      const need = db.prepare('INSERT INTO patient_needs (patient_id, kind, battery_hours) VALUES (?, ?, ?)')
      for (const n of p.needs) await need.run(patientId, n.kind, n.batteryHours)
      if (intakeId) await db.prepare("UPDATE intakes SET status = 'confirmed', patient_id = ? WHERE id = ? AND caregiver_id = ? AND status = 'draft'").run(patientId, intakeId, u.id)
      return patientId
    })
    return c.json(await withFeed({ id }), 201)
  })

  // Briefing: an AI draft for the organization that claimed the event; a coordinator edits and approves it before use.
  .post('/events/:id/briefing', requireRole('coordinator'), aiBudget, small, idParam, valid('json', BriefingBody), async (c) => {
    const u = (await currentUser(c))!
    const ev = await eventFor(u, c.req.valid('param').id)
    if (!ev) return c.json(await withFeed({ error: 'Caso no encontrado' }), 404)
    if (ev.claimedByOrgId === null || ev.claimedByOrgId !== u.orgId) return c.json(await withFeed({ error: NOT_CLAIMED }), 403)
    const { text, lang } = c.req.valid('json')
    if (text) { // written by the coordinator: no AI involved, and it still needs the approve step
      const { id } = await db.prepare('INSERT INTO briefings (event_id, draft_text) VALUES (?, ?) RETURNING id').get(ev.id, text) as { id: number }
      return c.json(await withFeed({ id, draftText: text }), 201)
    }
    const reply = await db.prepare('SELECT reply_text AS replyText FROM checkins WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(ev.id) as { replyText: string | null } | undefined
    const reasons = (await callList(u)).find((e) => e.eventId === ev.id)?.reasons ?? [] // the fixed rules explain the position; the AI only words it
    try {
      const draft = await draftBriefing({ patientName: ev.patientName, municipality: ev.municipality, zone: ev.zone, status: ev.status,
        needs: JSON.parse(ev.needs) as Need[], reasons, reply: reply?.replyText ?? null }, lang)
      const draftText = `${draft.briefing}\n\n${lang === 'en' ? 'Call script' : 'Guion de llamada'}:\n${draft.callScript}`
      const { id } = await db.prepare('INSERT INTO briefings (event_id, draft_text) VALUES (?, ?) RETURNING id').get(ev.id, draftText) as { id: number }
      return c.json(await withFeed({ id, draftText }), 201)
    } catch (e) {
      console.error('draftBriefing failed', e)
      return c.json(await withFeed({ error: 'No se pudo redactar el resumen automáticamente. Intente de nuevo.' }), 502)
    }
  })
  .post('/briefings/:id/approve', requireRole('coordinator'), small, idParam, valid('json', z.object({ text: z.string().trim().min(1).max(4000) })), async (c) => {
    const u = (await currentUser(c))!
    const row = await db.prepare(`SELECT b.id, e.claimed_by_org_id AS claimedByOrgId FROM briefings b JOIN outage_events e ON e.id = b.event_id JOIN patients p ON p.id = e.patient_id
      WHERE b.id = :id AND e.mode = :mode AND ${COVERS}`).get({ id: c.req.valid('param').id, ...await scope(u) }) as { id: number; claimedByOrgId: number | null } | undefined
    if (!row) return c.json(await withFeed({ error: 'Resumen no encontrado' }), 404)
    if (row.claimedByOrgId === null || row.claimedByOrgId !== u.orgId) return c.json(await withFeed({ error: NOT_CLAIMED }), 403)
    await db.prepare(`UPDATE briefings SET approved_text = ?, approved_by = ?, approved_at = ${NOW} WHERE id = ?`).run(c.req.valid('json').text, u.id, row.id)
    return c.json(await withFeed({ id: row.id }))
  })

  // Rehearsal reset (admin): back to the seeded patients, organizations and personas, live mode, no cases in progress.
  // Recorded LUMA readings are never touched: the replay depends on them.
  .post('/demo/reset', requireRole('admin'), async (c) => {
    await db.tx(async () => {
      await db.exec(`DELETE FROM messages; DELETE FROM briefings; DELETE FROM call_outcomes; DELETE FROM intakes;
        DELETE FROM checkins WHERE event_id IN (SELECT id FROM outage_events WHERE mode = 'replay' OR patient_id > ${seeded.patients});
        DELETE FROM outage_events WHERE mode = 'replay' OR patient_id > ${seeded.patients};
        DELETE FROM patient_needs WHERE patient_id > ${seeded.patients};
        DELETE FROM patients WHERE id > ${seeded.patients};
        DELETE FROM org_municipalities WHERE org_id > ${seeded.organizations};
        DELETE FROM organizations WHERE id > ${seeded.organizations};
        DELETE FROM users WHERE id > ${seeded.users};
        UPDATE checkins SET reply_text = NULL, reply_at = NULL, ai_parsed = NULL, confirmed_by = NULL, confirmed_at = NULL;
        UPDATE outage_events SET claimed_by_org_id = NULL, claimed_by = NULL, claimed_at = NULL,
          status = CASE WHEN status = 'confirmed' THEN 'possible' ELSE status END;
        UPDATE settings SET value = 'live' WHERE key = 'mode'`)
      const status = db.prepare('UPDATE organizations SET status = ?, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?')
      for (const [id, value] of seeded.orgStatus) await status.run(value, id)
    })
    return c.json(await withFeed({ patients: seeded.patients }))
  })
