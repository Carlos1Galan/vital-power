import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { pollOnce } from './luma.ts'
import { CHECKIN_MESSAGE, callList, claimEvent, coverageGaps, feedStatus, knownZones, processTownsReading, setEventStatus } from './events.ts'

// Seed: patients 1 + 5 in CAGUAS / URB VILLA BLANCA, 2 in CAGUAS / CANABONCITO/SEC HORMIGAS, 3 + 4 in SAN JUAN / HATO REY SUR.
// Orgs: 1 approved (CAGUAS, SAN JUAN), 2 approved (CAGUAS), 3 pending (SAN JUAN).
const reading = (payload: object, ok = 1) =>
  Number(db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, ?, ?)")
    .run(ok, JSON.stringify(payload)).lastInsertRowid)
const z = (...zones: string[]) => zones.map((zone) => ({ zone, area: 'X' }))
const openEvents = () => db.prepare("SELECT id, patient_id FROM outage_events WHERE status IN ('possible','confirmed') ORDER BY patient_id").all() as { id: number; patient_id: number }[]
const admin = { role: 'admin', orgId: null } as const
const coord = (orgId: number) => ({ role: 'coordinator', orgId }) as const

beforeEach(() => db.exec('DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings'))

test('a zone in a reading opens a possible event, a check-in and a ranked call-list entry', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA'), SAN_JUAN: [] }))
  assert.deepEqual(openEvents().map((e) => e.patient_id), [1, 5])
  const checkins = db.prepare('SELECT message FROM checkins').all() as { message: string }[]
  assert.deepEqual(checkins.map((c) => c.message), [CHECKIN_MESSAGE, CHECKIN_MESSAGE])
  const list = callList(admin)
  assert.equal(list.length, 2)
  assert.equal(list[0].patientName.length > 0, true)
  assert.deepEqual(list[0].reasons, ['Posible apagón, sin confirmar'])
  assert.equal(list[0].claimedBy, null)
})

test('the same zone in the next reading does not open a second event', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }))
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }))
  assert.equal(openEvents().length, 2)
  assert.equal((db.prepare('SELECT count(*) n FROM checkins').get() as { n: number }).n, 2)
})

test('an event is restored when its zone leaves the feed, not when its municipality is missing', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA'), 'SAN JUAN': z('HATO REY SUR') }))
  processTownsReading(reading({ 'SAN JUAN': z('HATO REY SUR') })) // CAGUAS not asked: keep open
  assert.equal(openEvents().length, 4)
  const r = reading({ CAGUAS: [], 'SAN JUAN': z('HATO REY SUR') })
  processTownsReading(r)
  assert.deepEqual(openEvents().map((e) => e.patient_id), [3, 4])
  const closed = db.prepare("SELECT closed_reading_id, closed_at FROM outage_events WHERE status = 'restored'").all() as { closed_reading_id: number; closed_at: string }[]
  assert.equal(closed.length, 2)
  assert.ok(closed.every((c) => c.closed_reading_id === r && c.closed_at))
})

test('a failed reading changes nothing', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }, 0))
  assert.equal(openEvents().length, 0)
})

test('every zone in a reading grows the catalogue', () => {
  processTownsReading(reading({ CAGUAS: z('BO NUEVO ZONA TEST') }))
  assert.ok(knownZones('CAGUAS').includes('BO NUEVO ZONA TEST'))
  assert.ok(knownZones('CAGUAS').includes('URB VILLA BLANCA')) // seed
  assert.deepEqual(knownZones('PONCE'), [])
})

test('pollOnce in live mode turns a towns reading into events', async () => {
  const f = (async (url: string | URL | Request) => new Response(String(url).endsWith('/towns')
    ? JSON.stringify({ 'SAN JUAN': z('HATO REY SUR') })
    : JSON.stringify({ regions: [], timestamp: 't' }))) as typeof fetch
  await pollOnce(f)
  assert.deepEqual(openEvents().map((e) => e.patient_id), [3, 4])
})

test('claimEvent: the first organization wins, the second gets false', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }))
  const [e] = openEvents()
  assert.equal(claimEvent(e.id, 2, 3), true)
  assert.equal(claimEvent(e.id, 1, 2), false)
  const row = callList(coord(1)).find((r) => r.eventId === e.id)!
  assert.equal(row.claimedBy, 'Oficina de Emergencias Demo')
})

test('claimEvent refuses an organization that does not cover the patient', () => {
  processTownsReading(reading({ 'SAN JUAN': z('HATO REY SUR') }))
  const [e] = openEvents()
  assert.equal(claimEvent(e.id, 2, 3), false) // org 2 covers only CAGUAS
  assert.equal(claimEvent(e.id, 3, 4), false) // org 3 is pending
  assert.equal(claimEvent(e.id, 1, 2), true)
})

test("a pending organization's coordinator gets an empty call list", () => {
  processTownsReading(reading({ 'SAN JUAN': z('HATO REY SUR') }))
  assert.equal(callList(admin).length, 2)
  assert.deepEqual(callList(coord(3)), [])
})

test('an organization covering only X never sees a patient in Y', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA'), 'SAN JUAN': z('HATO REY SUR') }))
  assert.deepEqual(callList(coord(2)).map((r) => r.municipality), ['CAGUAS', 'CAGUAS'])
  assert.equal(callList(coord(1)).length, 4)
})

test('caregivers get no call list', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }))
  assert.deepEqual(callList({ role: 'caregiver', orgId: null }), [])
})

test('call list is ranked by the fixed rules', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA', 'CANABONCITO/SEC HORMIGAS') }))
  const p2 = openEvents().find((e) => e.patient_id === 2)!
  setEventStatus(p2.id, 'confirmed') // insulin → tier 2
  const list = callList(admin)
  assert.equal(list[0].eventId, p2.id)
  assert.deepEqual(list[0].reasons, ['Sin luz confirmada; insulina en nevera'])
})

test('setEventStatus closes an event and will not reopen it', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }))
  const [e] = openEvents()
  assert.equal(setEventStatus(e.id, 'false_alarm'), true)
  assert.ok((db.prepare('SELECT closed_at FROM outage_events WHERE id = ?').get(e.id) as { closed_at: string }).closed_at)
  assert.equal(setEventStatus(e.id, 'confirmed'), false)
})

test('coverage gaps list exactly the patients no approved organization covers', () => {
  assert.deepEqual(coverageGaps(), []) // seed: CAGUAS and SAN JUAN are both covered
  db.exec('BEGIN')
  try {
    db.exec("DELETE FROM org_municipalities WHERE org_id = 1 AND municipality = 'SAN JUAN'") // only pending org 3 left there
    assert.deepEqual(coverageGaps().map((p) => p.id), [3, 4])
  } finally {
    db.exec('ROLLBACK')
  }
})

test('processing the same reading twice adds no second check-in', () => {
  const r = reading({ CAGUAS: z('URB VILLA BLANCA') })
  processTownsReading(r)
  processTownsReading(r) // replay restarted from the same reading
  assert.equal((db.prepare('SELECT count(*) n FROM checkins').get() as { n: number }).n, 2)
})

test('a closed event cannot be claimed', () => {
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') }))
  const [e] = openEvents()
  setEventStatus(e.id, 'false_alarm')
  assert.equal(claimEvent(e.id, 1, 2), false)
})

test('replay with a cursor that points at no reading is stale, not fresh', () => {
  db.exec("UPDATE settings SET value = 'replay' WHERE key = 'mode'; UPDATE settings SET value = '424242' WHERE key = 'replay_cursor'")
  try {
    assert.deepEqual(feedStatus(), { lastReadingAt: null, stale: true, mode: 'replay' })
  } finally {
    db.exec("UPDATE settings SET value = 'live' WHERE key = 'mode'")
  }
})

test('replay and live events never touch each other', () => {
  const setMode = (m: string) => db.prepare("UPDATE settings SET value = ? WHERE key = 'mode'").run(m)
  processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') })) // live
  const [live] = openEvents()
  assert.equal(claimEvent(live.id, 1, 2), true)
  setMode('replay')
  try {
    processTownsReading(reading({ CAGUAS: [], 'SAN JUAN': z('HATO REY SUR') })) // replayed calm CAGUAS
    assert.equal((db.prepare('SELECT status FROM outage_events WHERE id = ?').get(live.id) as { status: string }).status, 'possible')
    assert.deepEqual(callList(admin).map((r) => r.municipality), ['SAN JUAN', 'SAN JUAN'])
  } finally {
    setMode('live')
  }
  assert.deepEqual(callList(admin).map((r) => r.municipality), ['CAGUAS', 'CAGUAS'])
})

test('only events of the current mode can be claimed', () => {
  db.exec("UPDATE settings SET value = 'replay' WHERE key = 'mode'")
  try {
    processTownsReading(reading({ CAGUAS: z('URB VILLA BLANCA') })) // replay event
  } finally {
    db.exec("UPDATE settings SET value = 'live' WHERE key = 'mode'")
  }
  const [e] = openEvents()
  assert.equal(claimEvent(e.id, 1, 2), false) // hidden from the live call list
})
