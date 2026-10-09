import { test, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { app } from './app.ts'
import { ai } from './ai.ts'
import { processTownsReading } from './events.ts'

// Seeded caregivers: 5 Ana (patients 1, 2 in CAGUAS), 6 facility staff (facility 4: patients 3, 4 in SAN JUAN), 7 Luis (self, patient 5).
const call = async (as: number | null, method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(as ? { Cookie: `vp_uid=${as}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, headers: res.headers, json: (await res.json()) as any }
}
const outage = (payload: object) =>
  processTownsReading(Number(db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, 1, ?)").run(JSON.stringify(payload)).lastInsertRowid))
const checkinOf = (patientId: number) =>
  (db.prepare('SELECT c.id FROM checkins c JOIN outage_events e ON e.id = c.event_id WHERE e.patient_id = ?').get(patientId) as { id: number }).id
const profile = { displayName: 'Doña Prueba (sintética)', phone: null, municipality: 'CAGUAS', zone: 'URB VILLA BLANCA', needs: [{ kind: 'oxygen', batteryHours: 3 }] }

beforeEach(() => {
  mock.restoreAll()
  db.exec('DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings; DELETE FROM patient_needs WHERE patient_id > 5; DELETE FROM intakes; DELETE FROM patients WHERE id > 5')
})

test('demo login sets a cookie with only the user id; personas carry their type', async () => {
  const personas = (await call(null, 'GET', '/demo/personas')).json.personas
  assert.deepEqual(personas.map((p: any) => p.personaType), ['admin', 'coordinator', 'coordinator', 'coordinator', 'caregiver-person', 'facility-staff', 'self-patient'])
  const login = await call(null, 'POST', '/demo/login', { userId: 6 })
  assert.match(login.headers.get('set-cookie')!, /^vp_uid=6;/)
  assert.equal((await call(null, 'POST', '/demo/login', { userId: 999 })).status, 404)
  assert.deepEqual((await call(6, 'GET', '/demo/me')).json.user, { id: 6, name: 'Personal del Hogar', role: 'caregiver', orgId: 4, facilityId: 4 })
  assert.equal((await call(null, 'GET', '/demo/me')).json.user, null)
})

test('caregivers see their own patients; facility staff see all of the facility', async () => {
  const ids = async (as: number) => (await call(as, 'GET', '/patients/mine')).json.patients.map((p: any) => p.id)
  assert.deepEqual(await ids(5), [1, 2])
  assert.deepEqual(await ids(6), [3, 4])
  assert.deepEqual(await ids(7), [5])
  assert.equal((await call(2, 'GET', '/patients/mine')).status, 403) // coordinators use the call list
  assert.equal((await call(null, 'GET', '/patients/mine')).status, 401)
})

test('a caregiver answering another caregiver\'s check-in gets 404', async () => {
  outage({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'X' }], 'SAN JUAN': [{ zone: 'HATO REY SUR', area: 'X' }] })
  const pending = async (as: number) => (await call(as, 'GET', '/checkins/pending')).json.checkins.map((c: any) => c.patientId)
  assert.deepEqual(await pending(5), [1])
  assert.deepEqual(await pending(6), [3, 4])
  assert.equal((await call(5, 'POST', `/checkins/${checkinOf(3)}/reply`, { text: 'no hay luz' })).status, 404)
  assert.equal(db.prepare('SELECT reply_text FROM checkins WHERE id = ?').get(checkinOf(3))?.reply_text, null)
})

test('only check-ins of the current mode can be answered, as the pending list shows them', async () => {
  outage({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'X' }] }) // live events
  db.exec("UPDATE settings SET value = 'replay' WHERE key = 'mode'")
  try {
    assert.deepEqual((await call(5, 'GET', '/checkins/pending')).json.checkins, [])
    assert.equal((await call(5, 'POST', `/checkins/${checkinOf(1)}/reply`, { text: 'sin luz' })).status, 404)
  } finally {
    db.exec("UPDATE settings SET value = 'live' WHERE key = 'mode'")
  }
})

test('a reply is saved even when the AI fails, and only once', async () => {
  outage({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'X' }] })
  mock.method(ai, 'parseReply', async () => { throw new Error('no key') })
  const id = checkinOf(1)
  assert.equal((await call(5, 'POST', `/checkins/${id}/reply`, { text: 'No tenemos luz, la batería dura 2 horas' })).status, 200)
  const row = db.prepare('SELECT reply_text, ai_parsed FROM checkins WHERE id = ?').get(id) as { reply_text: string; ai_parsed: string | null }
  assert.deepEqual({ ...row }, { reply_text: 'No tenemos luz, la batería dura 2 horas', ai_parsed: null })
  assert.equal((await call(5, 'POST', `/checkins/${id}/reply`, { text: 'otra vez' })).status, 409)
  assert.deepEqual((await call(5, 'GET', '/checkins/pending')).json.checkins, [])
})

test('the AI reading of a reply is stored next to the original', async () => {
  outage({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'X' }] })
  mock.method(ai, 'parseReply', async () => ({ hasPower: false, needsHelp: true, summary: 'Sin luz' }))
  const id = checkinOf(5)
  await call(7, 'POST', `/checkins/${id}/reply`, { text: 'sin luz' })
  assert.deepEqual(JSON.parse((db.prepare('SELECT ai_parsed FROM checkins WHERE id = ?').get(id) as { ai_parsed: string }).ai_parsed), { hasPower: false, needsHelp: true, summary: 'Sin luz' })
})

test('intake: AI draft, then the confirmed profile becomes a patient; facility_id comes from the user', async () => {
  mock.method(ai, 'extractProfile', async () => ({ ...profile, displayName: 'IA' }))
  const ex = await call(6, 'POST', '/intake/extract', { transcript: 'Mi mamá vive en Villa Blanca, Caguas, usa oxígeno' })
  assert.equal(ex.json.draft.displayName, 'IA')
  assert.ok(ex.json.zones.includes('URB VILLA BLANCA'))
  const body = { intakeId: ex.json.intakeId, isSelf: true, consent: true, profile, facilityId: 1 } // extra keys are ignored
  const saved = await call(6, 'POST', '/patients', body)
  assert.equal(saved.status, 201)
  const p = db.prepare('SELECT caregiver_id, facility_id, is_self, consent_version FROM patients WHERE id = ?').get(saved.json.id) as object
  assert.deepEqual({ ...p }, { caregiver_id: 6, facility_id: 4, is_self: 0, consent_version: 'v1' })
  assert.equal((db.prepare('SELECT status FROM intakes WHERE id = ?').get(ex.json.intakeId) as { status: string }).status, 'confirmed')
  assert.equal((await call(6, 'POST', '/patients', body)).status, 404) // an intake confirms once
})

test('intake falls back to the manual form when the AI fails', async () => {
  mock.method(ai, 'extractProfile', async () => { throw new Error('no key') })
  const ex = await call(5, 'POST', '/intake/extract', { transcript: 'Mi papá usa oxígeno' })
  assert.equal(ex.status, 200)
  assert.equal(ex.json.draft, null)
  assert.equal(typeof ex.json.warning, 'string')
})

test('POST /patients rejects no consent, an unknown zone, and a second self record', async () => {
  const post = (as: number, b: object) => call(as, 'POST', '/patients', { intakeId: null, isSelf: false, consent: true, profile, ...b })
  assert.equal((await post(5, { consent: false })).status, 400)
  assert.equal((await post(5, { profile: { ...profile, zone: 'ZONA INVENTADA' } })).status, 400)
  assert.equal((await post(5, { profile: { ...profile, municipality: 'Caguas' } })).status, 400)
  assert.equal((await post(5, { profile: { ...profile, zone: null } })).status, 201) // unknown zone is allowed as null
  assert.equal((await post(7, { isSelf: true })).status, 409) // Luis already has his own record
  assert.equal((await post(5, { isSelf: true })).status, 201)
})
