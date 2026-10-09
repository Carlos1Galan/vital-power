import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { db, setting } from './db.ts'
import { MUNICIPALITIES } from './municipalities.ts'
import { knownZones } from './events.ts'
import { COOKIE, currentUser, requireRole, type User } from './auth.ts'
import { ai, NEEDS } from './ai.ts'
import { small, valid, withFeed } from './routes-data.ts'

const CONSENT_VERSION = 'v1'
const caregiver = requireRole('caregiver')
const id = z.object({ id: z.coerce.number().int().positive() })

// Caregiver visibility lives in the SQL: own registrations, plus every patient of the user's facility.
const MINE = '(p.caregiver_id = :uid OR p.facility_id = :facilityId)'
const scope = (u: User) => ({ uid: u.id, facilityId: u.facilityId })

const PERSONAS = `SELECT u.id, u.name, u.role, o.name AS orgName, o.status AS orgStatus,
    CASE WHEN u.role <> 'caregiver' THEN u.role
         WHEN o.kind = 'facility' THEN 'facility-staff'
         WHEN EXISTS (SELECT 1 FROM patients WHERE caregiver_id = u.id AND is_self = 1) THEN 'self-patient'
         ELSE 'caregiver-person' END AS personaType
  FROM users u LEFT JOIN organizations o ON o.id = u.org_id ORDER BY u.id`

const PatientBody = z.object({
  intakeId: z.number().int().positive().nullable(),
  isSelf: z.boolean(),
  consent: z.literal(true),
  profile: z.object({
    displayName: z.string().trim().min(2).max(120),
    phone: z.string().trim().max(30).nullable(),
    municipality: z.enum(MUNICIPALITIES),
    zone: z.string().max(200).nullable(),
    needs: z.array(z.object({ kind: z.enum(NEEDS), batteryHours: z.number().min(0).max(240).nullable() })).min(1).max(6),
  }),
})

// Owned by B: demo login, caregiver area. Coordinator routes (claim, events, briefings, outcomes) come next.
export const appRoutes = new Hono()
  .get('/demo/personas', (c) => c.json(withFeed({ personas: db.prepare(PERSONAS).all() as Persona[] })))

  .post('/demo/login', small, valid('json', z.object({ userId: z.number().int().positive() })), (c) => {
    const { userId } = c.req.valid('json')
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return c.json(withFeed({ error: 'Persona no encontrada' }), 404)
    setCookie(c, COOKIE, String(userId), { httpOnly: true, sameSite: 'Lax', path: '/' })
    return c.json(withFeed({ userId }))
  })

  .post('/demo/logout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' })
    return c.json(withFeed({}))
  })

  .get('/demo/me', (c) => c.json(withFeed({ user: currentUser(c) })))

  // LUMA zones known for a municipality: the review form's zone picker.
  .get('/zones', valid('query', z.object({ municipality: z.enum(MUNICIPALITIES) })), (c) =>
    c.json(withFeed({ zones: knownZones(c.req.valid('query').municipality) })))

  // AI draft only; nothing becomes a patient until the caregiver reviews it and consents.
  .post('/intake/extract', caregiver, small, valid('json', z.object({ transcript: z.string().trim().min(5).max(4000) })), async (c) => {
    const { transcript } = c.req.valid('json')
    const intakeId = Number(db.prepare('INSERT INTO intakes (caregiver_id, transcript) VALUES (?, ?)').run(c.var.user.id, transcript).lastInsertRowid)
    try {
      const draft = await ai.extractProfile(transcript)
      db.prepare('UPDATE intakes SET ai_json = ? WHERE id = ?').run(JSON.stringify(draft), intakeId)
      return c.json(withFeed({ intakeId, draft, zones: draft.municipality ? knownZones(draft.municipality) : [], warning: null }))
    } catch (e) {
      console.error('extractProfile failed', e)
      return c.json(withFeed({ intakeId, draft: null, zones: [], warning: 'La IA no pudo leer el relato. Complete el formulario a mano.' }))
    }
  })

  .post('/patients', caregiver, small, valid('json', PatientBody), (c) => {
    const u = c.var.user
    const { intakeId, isSelf: wantsSelf, profile: p } = c.req.valid('json')
    if (p.zone !== null && !knownZones(p.municipality).includes(p.zone)) return c.json(withFeed({ error: 'Esa zona no está en el catálogo de LUMA para ese municipio' }), 400)
    const isSelf = wantsSelf && !u.facilityId // facility staff register residents, never themselves
    if (isSelf && db.prepare('SELECT 1 FROM patients WHERE caregiver_id = ? AND is_self = 1').get(u.id)) return c.json(withFeed({ error: 'Ya tiene un registro propio' }), 409)
    let patientId = 0
    db.exec('BEGIN')
    try {
      // facility_id comes from the current user, never from the body.
      patientId = Number(db.prepare(`INSERT INTO patients (caregiver_id, facility_id, is_self, display_name, phone, municipality, zone, consent_at, consent_version, confirmed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
        .run(u.id, u.facilityId, isSelf ? 1 : 0, p.displayName, p.phone, p.municipality, p.zone, CONSENT_VERSION).lastInsertRowid)
      const need = db.prepare('INSERT INTO patient_needs (patient_id, kind, battery_hours) VALUES (?, ?, ?)')
      for (const n of p.needs) need.run(patientId, n.kind, n.batteryHours)
      if (intakeId !== null && !db.prepare("UPDATE intakes SET status = 'confirmed', patient_id = ? WHERE id = ? AND caregiver_id = ? AND status = 'draft'").run(patientId, intakeId, u.id).changes) {
        db.exec('ROLLBACK')
        return c.json(withFeed({ error: 'Registro de entrevista no encontrado' }), 404)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return c.json(withFeed({ id: patientId }), 201)
  })

  .get('/patients/mine', caregiver, (c) => {
    const u = c.var.user
    const rows = db.prepare(`SELECT p.id, p.display_name AS displayName, p.is_self AS isSelf, p.facility_id IS NOT NULL AS facility,
        p.phone, p.municipality, p.zone,
        (SELECT json_group_array(json_object('kind', kind, 'batteryHours', battery_hours)) FROM patient_needs WHERE patient_id = p.id) AS needs,
        (SELECT status FROM outage_events WHERE patient_id = p.id AND mode = :mode AND status IN ('possible','confirmed')) AS eventStatus
      FROM patients p WHERE ${MINE} ORDER BY p.id`).all({ ...scope(u), mode: setting('mode') }) as (Omit<MyPatient, 'needs'> & { needs: string })[]
    const hasSelf = !!db.prepare('SELECT 1 FROM patients WHERE caregiver_id = ? AND is_self = 1').get(u.id)
    return c.json(withFeed({ hasSelf, isFacility: u.facilityId !== null, patients: rows.map((r) => ({ ...r, needs: JSON.parse(r.needs) as Need[] })) }))
  })

  // The demo's "patient phone": unanswered check-ins on open events the user may see.
  .get('/checkins/pending', caregiver, (c) =>
    c.json(withFeed({
      checkins: db.prepare(`SELECT c.id, c.message, c.sent_at AS sentAt, p.id AS patientId, p.display_name AS patientName
        FROM checkins c JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
        WHERE c.reply_text IS NULL AND e.status IN ('possible','confirmed') AND e.mode = :mode AND ${MINE}
        ORDER BY c.sent_at`).all({ ...scope(c.var.user), mode: setting('mode') }) as PendingCheckin[],
    })))

  // The reply is saved first; the AI reading is a best-effort extra the coordinator checks against the original.
  .post('/checkins/:id/reply', caregiver, small, valid('param', id), valid('json', z.object({ text: z.string().trim().min(1).max(1000) })), async (c) => {
    const checkinId = c.req.valid('param').id
    const { text } = c.req.valid('json')
    const row = db.prepare(`SELECT c.message FROM checkins c JOIN outage_events e ON e.id = c.event_id JOIN patients p ON p.id = e.patient_id
      WHERE c.id = :checkinId AND e.status IN ('possible','confirmed') AND e.mode = :mode AND ${MINE}`).get({ ...scope(c.var.user), checkinId, mode: setting('mode') }) as { message: string } | undefined
    if (!row) return c.json(withFeed({ error: 'Mensaje no encontrado' }), 404)
    const saved = db.prepare("UPDATE checkins SET reply_text = ?, reply_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND reply_text IS NULL").run(text, checkinId).changes
    if (!saved) return c.json(withFeed({ error: 'Este mensaje ya fue contestado' }), 409)
    try {
      db.prepare('UPDATE checkins SET ai_parsed = ? WHERE id = ?').run(JSON.stringify(await ai.parseReply(row.message, text)), checkinId)
    } catch (e) {
      console.error('parseReply failed', e)
    }
    return c.json(withFeed({ id: checkinId }))
  })

type Persona = { id: number; name: string; role: User['role']; orgName: string | null; orgStatus: string | null; personaType: 'admin' | 'coordinator' | 'facility-staff' | 'self-patient' | 'caregiver-person' }
type Need = { kind: (typeof NEEDS)[number]; batteryHours: number | null }
type MyPatient = { id: number; displayName: string; isSelf: number; facility: number; phone: string | null; municipality: string; zone: string | null; needs: Need[]; eventStatus: 'possible' | 'confirmed' | null }
type PendingCheckin = { id: number; message: string; sentAt: string; patientId: number; patientName: string }
