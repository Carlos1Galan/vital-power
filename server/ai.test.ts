import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { app } from './app.ts'
import { ai } from './ai.ts'
import { processTownsReading } from './events.ts'

// The SDK is never called in tests: ai.complete is replaced by a canned answer (or a failure).
let answer: unknown = null
const prompts: { system: string; user: string }[] = []
ai.complete = (async (_schema: unknown, system: string, user: string) => {
  prompts.push({ system, user })
  if (answer instanceof Error) throw answer
  return answer
}) as typeof ai.complete
console.error = () => {} // the routes log AI failures by design; keep the test output readable

const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const feedKeys = (j: object) => assert.deepEqual(['lastReadingAt', 'mode', 'stale'].filter((k) => k in j), ['lastReadingAt', 'mode', 'stale'])
const [PLAN, OME, ANA, HOGAR, LUIS] = [2, 3, 5, 6, 7].map((id) => `vp_user=${id}`)
const eventOf = (patientId: number) => (db.prepare("SELECT id FROM outage_events WHERE patient_id = ? AND status IN ('possible','confirmed')").get(patientId) as { id: number }).id
const checkinOf = (patientId: number) => (db.prepare('SELECT id FROM checkins WHERE event_id = ?').get(eventOf(patientId)) as { id: number }).id
const settle = () => new Promise((r) => setTimeout(r, 10)) // the reply reading is stored after the response
const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n

const draft = { displayName: 'Don Ramón', phone: null, municipality: 'CAGUAS', zone: 'URB VILLA BLANCA', needs: [{ kind: 'oxygen', batteryHours: 2 }, { kind: 'insulin', batteryHours: null }] }
const profile = { displayName: 'Doña Luz (sintética)', phone: '787-555-0199', municipality: 'CAGUAS', zone: 'URB VILLA BLANCA', needs: [{ kind: 'cpap', batteryHours: 6 }] }

const reset = () => {
  db.exec(`DELETE FROM briefings; DELETE FROM call_outcomes; DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings;
    DELETE FROM intakes; DELETE FROM patient_needs WHERE patient_id > 5; DELETE FROM patients WHERE id > 5;
    UPDATE settings SET value = 'live' WHERE key = 'mode'`)
}
beforeEach(() => {
  reset()
  prompts.length = 0
  answer = null
  const id = Number(db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, 1, ?)")
    .run(JSON.stringify({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'CAGUAS' }] })).lastInsertRowid)
  processTownsReading(id) // opens events for patients 1 and 5
})
after(reset)

test('intake extract returns the AI draft, stores the intake, and saves no patient', async () => {
  answer = draft
  const { status, json } = await call('POST', '/intake/extract', { transcript: 'Mi papá Don Ramón vive en Villa Blanca, Caguas, usa concentrador con batería de dos horas e insulina.' }, ANA)
  assert.equal(status, 200)
  feedKeys(json)
  assert.deepEqual(json.profile, draft)
  assert.ok(json.zones.includes('URB VILLA BLANCA'))
  assert.deepEqual({ ...(db.prepare('SELECT caregiver_id, status, patient_id FROM intakes WHERE id = ?').get(json.intakeId) as object) }, { caregiver_id: 5, status: 'draft', patient_id: null })
  assert.equal(count('patients'), 5)
  assert.match(prompts[0].user, /<relato>\nMi papá Don Ramón/) // the transcript travels as data, inside tags
  assert.match(prompts[0].system, /CAGUAS: .*URB VILLA BLANCA/) // the model sees the zone catalogue
})

test('a zone the AI returns that is not in knownZones(municipality) becomes null', async () => {
  answer = { ...draft, zone: 'BARRIO INVENTADO' }
  assert.equal((await call('POST', '/intake/extract', { transcript: 'vive en un barrio inventado de Caguas' }, ANA)).json.profile.zone, null)
  answer = { ...draft, municipality: 'SAN JUAN' } // a real zone, but of another municipality
  assert.equal((await call('POST', '/intake/extract', { transcript: 'vive en San Juan' }, ANA)).json.profile.zone, null)
  answer = { ...draft, municipality: null }
  assert.equal((await call('POST', '/intake/extract', { transcript: 'no dijo el pueblo' }, ANA)).json.profile.zone, null)
})

test('intake extract answers 502 with a readable error when the AI fails or returns a bad shape', async () => {
  answer = new Error('network down')
  const failed = await call('POST', '/intake/extract', { transcript: 'mi mamá usa CPAP' }, ANA)
  assert.equal(failed.status, 502)
  assert.equal(typeof failed.json.error, 'string')
  feedKeys(failed.json)
  answer = { ...draft, municipality: 'Caguas' } // not LUMA's spelling
  assert.equal((await call('POST', '/intake/extract', { transcript: 'mi mamá usa CPAP' }, ANA)).status, 502)
  answer = { ...draft, needs: [{ kind: 'wheelchair', batteryHours: 1 }] }
  assert.equal((await call('POST', '/intake/extract', { transcript: 'mi mamá usa CPAP' }, ANA)).status, 502)
  assert.equal(count('intakes'), 0)
  assert.equal((await call('POST', '/intake/extract', { transcript: 'x' }, ANA)).status, 400)
  assert.equal((await call('POST', '/intake/extract', { transcript: 'mi mamá usa CPAP' }, PLAN)).status, 403)
})

test('saving a confirmed profile creates the patient with consent and closes the intake', async () => {
  answer = draft
  const { intakeId } = (await call('POST', '/intake/extract', { transcript: 'registro de prueba' }, ANA)).json
  const saved = await call('POST', '/patients', { intakeId, isSelf: false, consent: true, profile }, ANA)
  assert.equal(saved.status, 201)
  feedKeys(saved.json)
  const row = db.prepare('SELECT caregiver_id, facility_id, is_self, display_name, municipality, zone, consent_version, consent_at IS NOT NULL AS consented FROM patients WHERE id = ?').get(saved.json.id) as object
  assert.deepEqual({ ...row }, { caregiver_id: 5, facility_id: null, is_self: 0, display_name: 'Doña Luz (sintética)', municipality: 'CAGUAS', zone: 'URB VILLA BLANCA', consent_version: 'v1', consented: 1 })
  assert.deepEqual((db.prepare('SELECT kind, battery_hours FROM patient_needs WHERE patient_id = ?').all(saved.json.id) as object[]).map((n) => ({ ...n })), [{ kind: 'cpap', battery_hours: 6 }])
  assert.deepEqual({ ...(db.prepare('SELECT status, patient_id FROM intakes WHERE id = ?').get(intakeId) as object) }, { status: 'confirmed', patient_id: saved.json.id })
  assert.ok((await call('GET', '/patients/mine', undefined, ANA)).json.patients.some((p: any) => p.id === saved.json.id))
})

test('facility_id comes from the current user, never from the request body', async () => {
  const staff = await call('POST', '/patients', { isSelf: false, consent: true, facilityId: 1, facility_id: 1, profile: { ...profile, zone: null } }, HOGAR)
  assert.equal(staff.status, 201)
  assert.equal((db.prepare('SELECT facility_id FROM patients WHERE id = ?').get(staff.json.id) as { facility_id: number }).facility_id, 4)
  const ana = await call('POST', '/patients', { isSelf: false, consent: true, facilityId: 4, profile }, ANA)
  assert.equal((db.prepare('SELECT facility_id FROM patients WHERE id = ?').get(ana.json.id) as { facility_id: number | null }).facility_id, null)
})

test('saving a patient refuses missing consent, unknown places, a second self record and other roles', async () => {
  const body = { isSelf: false, consent: true, profile }
  assert.equal((await call('POST', '/patients', { ...body, consent: false }, ANA)).status, 400)
  assert.equal((await call('POST', '/patients', { isSelf: false, profile }, ANA)).status, 400)
  assert.equal((await call('POST', '/patients', { ...body, profile: { ...profile, municipality: 'Caguas' } }, ANA)).status, 400)
  assert.equal((await call('POST', '/patients', { ...body, profile: { ...profile, zone: 'BARRIO INVENTADO' } }, ANA)).status, 400)
  assert.equal((await call('POST', '/patients', { ...body, profile: { ...profile, needs: [] } }, ANA)).status, 400)
  assert.equal((await call('POST', '/patients', { ...body, isSelf: true }, LUIS)).status, 409) // Luis already has his own record
  assert.equal((await call('POST', '/patients', body, PLAN)).status, 403)
  assert.equal((await call('POST', '/patients', body)).status, 401)
  assert.equal(count('patients'), 5)
  assert.deepEqual((await call('GET', '/zones/CAGUAS', undefined, ANA)).json.zones.includes('URB VILLA BLANCA'), true)
  assert.equal((await call('GET', '/zones/Caguas', undefined, ANA)).status, 400)
})

test('a reply is saved with its AI reading, and the coordinator sees both', async () => {
  answer = { hasPower: 'no', batteryHours: 2, summary: 'No hay luz y le quedan dos horas de batería.' }
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: 'Se fue la luz, quedan dos horas' }, ANA)).status, 200)
  await settle()
  assert.match(prompts[0].user, /<respuesta>\nSe fue la luz, quedan dos horas\n<\/respuesta>/)
  const { json } = await call('GET', `/events/${eventOf(1)}`, undefined, PLAN)
  assert.equal(json.checkin.replyText, 'Se fue la luz, quedan dos horas')
  assert.deepEqual(json.checkin.aiParsed, answer)
  assert.equal((db.prepare('SELECT status FROM outage_events WHERE id = ?').get(eventOf(1)) as { status: string }).status, 'possible') // the reading changes nothing by itself
})

test('an AI failure never loses the reply', async () => {
  answer = new Error('timeout')
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: 'No hay luz' }, ANA)).status, 200)
  await settle()
  const { json } = await call('GET', `/events/${eventOf(1)}`, undefined, PLAN)
  assert.equal(json.checkin.replyText, 'No hay luz')
  assert.equal(json.checkin.aiParsed, null)
})

test('only the organization that claimed the event drafts and approves the briefing', async () => {
  const id = eventOf(1)
  answer = { briefing: 'Don Ramón usa concentrador.', callScript: 'Buenas, le llamo de…' }
  assert.equal((await call('POST', `/events/${id}/briefing`, undefined, PLAN)).status, 403) // unclaimed
  await call('POST', `/events/${id}/claim`, undefined, OME)
  assert.equal((await call('POST', `/events/${id}/briefing`, undefined, PLAN)).status, 403)
  assert.equal(prompts.length, 0) // the AI is not even called for a refused request

  const made = await call('POST', `/events/${id}/briefing`, undefined, OME)
  assert.equal(made.status, 201)
  feedKeys(made.json)
  assert.equal(made.json.draftText, 'Don Ramón usa concentrador.\n\nGuion de llamada:\nBuenas, le llamo de…')
  assert.match(prompts[0].user, /Don Ramón \(sintético\)/)
  assert.match(prompts[0].user, /Posible apagón, sin confirmar/) // the fixed-rule reasons are given to the AI, not invented by it

  assert.equal((await call('POST', `/briefings/${made.json.id}/approve`, { text: 'Texto corregido' }, PLAN)).status, 403)
  assert.equal((await call('POST', `/briefings/${made.json.id}/approve`, { text: '' }, OME)).status, 400)
  assert.equal((await call('POST', '/briefings/99999/approve', { text: 'x' }, OME)).status, 404)
  assert.equal((await call('POST', `/briefings/${made.json.id}/approve`, { text: 'Texto corregido' }, OME)).status, 200)
  const { json } = await call('GET', `/events/${id}`, undefined, OME)
  assert.equal(json.briefing.approvedText, 'Texto corregido')
  assert.equal(json.briefing.draftText, made.json.draftText)
  assert.ok(json.briefing.approvedAt)
})

test('a failed briefing draft answers 502 and stores nothing', async () => {
  const id = eventOf(1)
  await call('POST', `/events/${id}/claim`, undefined, OME)
  answer = new Error('overloaded')
  const r = await call('POST', `/events/${id}/briefing`, undefined, OME)
  assert.equal(r.status, 502)
  assert.equal(typeof r.json.error, 'string')
  assert.equal(count('briefings'), 0)
  assert.equal((await call('GET', `/events/${id}`, undefined, OME)).json.briefing, null)
})

test('AI drafts are limited per user per minute', async () => {
  answer = draft
  const body = { transcript: 'mi mamá usa CPAP en Caguas' }
  const statuses: number[] = []
  for (let i = 0; i < 21; i++) statuses.push((await call('POST', '/intake/extract', body, HOGAR)).status)
  assert.deepEqual([statuses.slice(0, 20).every((s) => s === 200), statuses[20]], [true, 429])
  assert.equal((await call('POST', '/intake/extract', body, LUIS)).status, 200) // another user has their own budget
})
