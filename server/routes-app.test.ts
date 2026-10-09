import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { app } from './app.ts'
import { processTownsReading } from './events.ts'
import { ai } from './ai.ts'

// No network in tests: the AI reading of a reply is off here (server/ai.test.ts covers it).
ai.complete = (async () => { throw new Error('AI is off in this test file') }) as typeof ai.complete
console.error = () => {} // the reply route logs that failure by design

const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const feedKeys = (j: object) => assert.deepEqual(['lastReadingAt', 'mode', 'stale'].filter((k) => k in j), ['lastReadingAt', 'mode', 'stale'])
const as = (userId: number) => `vp_user=${userId}`
// Seed personas: 1 admin; coordinators 2 (CAGUAS + SAN JUAN), 3 (CAGUAS), 4 (pending org); caregivers 5 (patients 1, 2), 6 (facility: 3, 4), 7 (self: 5).
const [ADMIN, PLAN, OME, PENDING, ANA, HOGAR, LUIS] = [1, 2, 3, 4, 5, 6, 7].map(as)

// An outage in one CAGUAS zone (patients 1 and 5) and the SAN JUAN zone (patients 3 and 4).
const outage = () => {
  const id = Number(db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, 1, ?)").run(JSON.stringify({
    CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'CAGUAS' }], 'SAN JUAN': [{ zone: 'HATO REY SUR', area: 'SAN JUAN' }],
  })).lastInsertRowid)
  processTownsReading(id)
}
const eventOf = (patientId: number) => (db.prepare("SELECT id FROM outage_events WHERE patient_id = ? AND status IN ('possible','confirmed')").get(patientId) as { id: number }).id
const checkinOf = (patientId: number) => (db.prepare('SELECT id FROM checkins WHERE event_id = ?').get(eventOf(patientId)) as { id: number }).id
const statusOf = (eventId: number) => (db.prepare('SELECT status FROM outage_events WHERE id = ?').get(eventId) as { status: string }).status

beforeEach(() => {
  db.exec("DELETE FROM briefings; DELETE FROM call_outcomes; DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings; UPDATE settings SET value = 'live' WHERE key = 'mode'")
  outage()
})

test('a caregiver sees only their own patients, with the open outage', async () => {
  const { status, json } = await call('GET', '/patients/mine', undefined, ANA)
  assert.equal(status, 200)
  feedKeys(json)
  assert.deepEqual(json.patients.map((p: any) => [p.id, p.outage]), [[1, 'possible'], [2, null]])
  assert.deepEqual(json.patients[0].needs, [{ kind: 'oxygen', batteryHours: 2 }])
})

test('facility staff see every patient of the facility; a self-registered patient sees only themself', async () => {
  assert.deepEqual((await call('GET', '/patients/mine', undefined, HOGAR)).json.patients.map((p: any) => p.id), [3, 4])
  const luis = (await call('GET', '/patients/mine', undefined, LUIS)).json.patients
  assert.deepEqual(luis.map((p: any) => [p.id, p.isSelf]), [[5, true]])
})

test('the caregiver routes refuse coordinators and visitors with no persona', async () => {
  assert.equal((await call('GET', '/patients/mine', undefined, PLAN)).status, 403)
  assert.equal((await call('GET', '/checkins/pending')).status, 401)
})

test('pending check-ins are scoped to the caregiver and disappear once answered', async () => {
  const pending = await call('GET', '/checkins/pending', undefined, ANA)
  assert.deepEqual(pending.json.checkins.map((k: any) => k.patientId), [1])
  assert.equal(pending.json.checkins[0].message, '¿Tiene luz en su casa?')
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: '  No hay luz desde las 3  ' }, ANA)).status, 200)
  assert.equal((db.prepare('SELECT reply_text FROM checkins WHERE id = ?').get(checkinOf(1)) as { reply_text: string }).reply_text, 'No hay luz desde las 3')
  assert.deepEqual((await call('GET', '/checkins/pending', undefined, ANA)).json.checkins, [])
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: 'otra vez' }, ANA)).status, 404) // one reply only
})

test("a caregiver replying to another caregiver's check-in gets 404 and changes nothing", async () => {
  const r = await call('POST', `/checkins/${checkinOf(3)}/reply`, { text: 'no es mío' }, ANA)
  assert.equal(r.status, 404)
  assert.equal(typeof r.json.error, 'string')
  assert.equal((db.prepare('SELECT reply_at FROM checkins WHERE id = ?').get(checkinOf(3)) as { reply_at: string | null }).reply_at, null)
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: '' }, ANA)).status, 400)
  assert.equal((await call('POST', '/checkins/abc/reply', { text: 'x' }, ANA)).status, 400)
})

test('the first organization to claim wins and the second gets 409 with the winner', async () => {
  const id = eventOf(1)
  const first = await call('POST', `/events/${id}/claim`, undefined, OME)
  assert.equal(first.status, 200)
  assert.equal(first.json.claimedBy, 'Oficina de Emergencias Demo')
  const second = await call('POST', `/events/${id}/claim`, undefined, PLAN)
  assert.equal(second.status, 409)
  assert.equal(second.json.error, 'Atendido por Oficina de Emergencias Demo')
  feedKeys(second.json)
  assert.equal((await call('POST', `/events/${id}/claim`, undefined, OME)).status, 200) // claiming again is harmless
})

test('a coordinator cannot see or claim outside its municipalities; a pending organization has none', async () => {
  const sanJuan = eventOf(3)
  assert.equal((await call('POST', `/events/${sanJuan}/claim`, undefined, OME)).status, 404) // covers CAGUAS only
  assert.equal((await call('GET', `/events/${sanJuan}`, undefined, OME)).status, 404)
  assert.equal((await call('POST', `/events/${sanJuan}/claim`, undefined, PENDING)).status, 404) // org not approved
  assert.equal((await call('GET', `/events/${sanJuan}`, undefined, PLAN)).status, 200)
  assert.equal((await call('POST', `/events/${sanJuan}/claim`, undefined, ADMIN)).status, 403) // admin has no organization
  assert.equal((await call('POST', `/events/${sanJuan}/claim`, undefined, ANA)).status, 403)
  assert.equal(statusOf(sanJuan), 'possible')
})

test('the event view shows the original reply, with no AI reading when the AI is unavailable', async () => {
  await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: 'No hay luz' }, ANA)
  await call('POST', `/events/${eventOf(1)}/claim`, undefined, PLAN)
  const { json } = await call('GET', `/events/${eventOf(1)}`, undefined, PLAN)
  feedKeys(json)
  assert.equal(json.event.patientName, 'Don Ramón (sintético)')
  assert.equal(json.event.mine, true)
  assert.equal(json.checkin.replyText, 'No hay luz')
  assert.equal(json.checkin.aiParsed, null)
  assert.deepEqual(json.outcomes, [])
  assert.equal((await call('GET', `/events/${eventOf(1)}`, undefined, OME)).json.event.mine, false)
  assert.equal((await call('GET', `/events/${eventOf(1)}`, undefined, ADMIN)).status, 200)
})

test('a coordinator confirms a reply: no power confirms the outage, power closes it', async () => {
  const noReply = await call('POST', `/checkins/${checkinOf(1)}/confirm`, { hasPower: false }, PLAN)
  assert.equal(noReply.status, 409) // nothing to confirm yet
  await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: 'No hay luz' }, ANA)
  const ramon = eventOf(1)
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/confirm`, { hasPower: false }, PLAN)).json.status, 'confirmed')
  assert.equal(statusOf(ramon), 'confirmed')
  assert.equal((await call('POST', `/checkins/${checkinOf(1)}/confirm`, { hasPower: true }, OME)).json.status, 'restored')

  await call('POST', `/checkins/${checkinOf(5)}/reply`, { text: 'Sí tenemos luz' }, LUIS)
  const luis = eventOf(5), luisCheckin = checkinOf(5)
  assert.equal((await call('POST', `/checkins/${luisCheckin}/confirm`, { hasPower: true }, PLAN)).json.status, 'false_alarm')
  assert.equal(statusOf(luis), 'false_alarm')
  assert.equal((await call('POST', `/checkins/${luisCheckin}/confirm`, { hasPower: false }, PLAN)).status, 409) // closed stays closed
  assert.equal((await call('POST', `/checkins/${checkinOf(3)}/confirm`, { hasPower: false }, OME)).status, 404) // SAN JUAN is not OME's
  assert.equal((await call('POST', `/checkins/${checkinOf(3)}/confirm`, { hasPower: 'no' }, PLAN)).status, 400)
})

test('only the organization that claimed the event records the outcome', async () => {
  const id = eventOf(1)
  const body = { reached: true, outcome: 'Tiene batería para 2 horas', nextAction: 'Llevar generador' }
  assert.equal((await call('POST', `/events/${id}/outcome`, body, PLAN)).status, 403) // nobody claimed it yet
  await call('POST', `/events/${id}/claim`, undefined, OME)
  const other = await call('POST', `/events/${id}/outcome`, body, PLAN)
  assert.equal(other.status, 403)
  feedKeys(other.json)
  assert.equal((await call('POST', `/events/${id}/outcome`, body, OME)).status, 201)
  assert.equal((await call('POST', `/events/${id}/outcome`, { reached: true, outcome: '' }, OME)).status, 400)
  const { json } = await call('GET', `/events/${id}`, undefined, OME)
  assert.deepEqual(json.outcomes.map((o: any) => [o.reached, o.outcome, o.nextAction, o.coordinator]), [[true, 'Tiene batería para 2 horas', 'Llevar generador', 'Coordinador Emergencias']])
})

test('the caregiver sees who took the case and the result of the last call', async () => {
  const before = (await call('GET', '/patients/mine', undefined, ANA)).json.patients[0]
  assert.deepEqual([before.claimedBy, before.lastCall], [null, null])
  await call('POST', `/events/${eventOf(1)}/claim`, undefined, OME)
  await call('POST', `/events/${eventOf(1)}/outcome`, { reached: true, outcome: 'Tiene batería para 2 horas', nextAction: 'Llevar generador' }, OME)
  const after = (await call('GET', '/patients/mine', undefined, ANA)).json.patients
  assert.equal(after[0].claimedBy, 'Oficina de Emergencias Demo')
  assert.deepEqual([after[0].lastCall.reached, after[0].lastCall.outcome, after[0].lastCall.nextAction], [true, 'Tiene batería para 2 horas', 'Llevar generador'])
  assert.deepEqual([after[1].claimedBy, after[1].lastCall], [null, null]) // her other patient has no case
})

test('the demo reset returns to the seeded patients and organizations and keeps the recorded readings', async () => {
  const readings = (db.prepare('SELECT count(*) n FROM luma_readings').get() as { n: number }).n
  db.exec("INSERT INTO patients (id, caregiver_id, display_name, municipality, zone, consent_at, consent_version) VALUES (90, 5, 'Ensayo', 'CAGUAS', 'URB VILLA BLANCA', 'x', 'v1'); INSERT INTO patient_needs (patient_id, kind) VALUES (90, 'cpap')")
  db.exec("INSERT INTO organizations (id, name, kind, org_type, status) VALUES (90, 'Org de ensayo', 'responder', 'clinic', 'pending'); INSERT INTO org_municipalities VALUES (90, 'CAGUAS'); UPDATE organizations SET status = 'approved' WHERE id = 3")
  await call('POST', `/checkins/${checkinOf(1)}/reply`, { text: 'No hay luz' }, ANA)
  await call('POST', `/checkins/${checkinOf(1)}/confirm`, { hasPower: false }, PLAN)
  await call('POST', `/events/${eventOf(1)}/claim`, undefined, PLAN)
  await call('POST', `/events/${eventOf(1)}/outcome`, { reached: true, outcome: 'ok' }, PLAN)

  assert.equal((await call('POST', '/demo/reset', undefined, PLAN)).status, 403)
  const done = await call('POST', '/demo/reset', undefined, ADMIN)
  assert.equal(done.status, 200)
  feedKeys(done.json)
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n
  assert.equal(count('SELECT count(*) n FROM patients'), 5)
  assert.equal(count('SELECT count(*) n FROM patient_needs WHERE patient_id = 90'), 0)
  assert.equal(count('SELECT count(*) n FROM organizations'), 4)
  assert.equal(count('SELECT count(*) n FROM call_outcomes'), 0)
  assert.equal(count('SELECT count(*) n FROM luma_readings'), readings)
  assert.equal((db.prepare('SELECT status FROM organizations WHERE id = 3').get() as { status: string }).status, 'pending')
  const ev = db.prepare('SELECT status, claimed_by_org_id FROM outage_events WHERE id = ?').get(eventOf(1)) as { status: string; claimed_by_org_id: number | null }
  assert.deepEqual({ ...ev }, { status: 'possible', claimed_by_org_id: null })
  assert.equal((await call('GET', '/checkins/pending', undefined, ANA)).json.checkins.length, 1) // the check-in can be answered again
})
