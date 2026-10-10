import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { pollOnce } from './luma.ts'
import { CHECKIN_MESSAGE, callList, claimEvent, coverageGaps, feedStatus, knownZones, processTownsReading, setEventStatus } from './events.ts'

// Seed: patients 1 + 5 in CAGUAS / URB VILLA BLANCA, 2 in CAGUAS / CANABONCITO/SEC HORMIGAS, 3 + 4 in SAN JUAN / HATO REY SUR.
// Orgs: 1 approved (CAGUAS, SAN JUAN), 2 approved (CAGUAS), 3 pending (SAN JUAN).
const reading = async (payload: object, ok = 1) =>
  (await db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, ?, ?) RETURNING id")
    .get(ok, JSON.stringify(payload)) as { id: number }).id
const z = (...zones: string[]) => zones.map((zone) => ({ zone, area: 'X' }))
const openEvents = async () => await db.prepare("SELECT id, patient_id FROM outage_events WHERE status IN ('possible','confirmed') ORDER BY patient_id").all() as { id: number; patient_id: number }[]
const admin = { role: 'admin', orgId: null } as const
const coord = (orgId: number) => ({ role: 'coordinator', orgId }) as const

beforeEach(() => db.exec('DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings'))

test('a zone in a reading opens a possible event, a check-in and a ranked call-list entry', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA'), SAN_JUAN: [] }))
  assert.deepEqual((await openEvents()).map((e) => e.patient_id), [1, 5])
  const checkins = await db.prepare('SELECT message FROM checkins').all() as { message: string }[]
  assert.deepEqual(checkins.map((c) => c.message), [CHECKIN_MESSAGE, CHECKIN_MESSAGE])
  const list = await callList(admin)
  assert.equal(list.length, 2)
  assert.equal(list[0].patientName.length > 0, true)
  assert.deepEqual(list[0].reasons, ['Posible apagón, sin confirmar'])
  assert.equal(list[0].claimedBy, null)
})

test('the same zone in the next reading does not open a second event', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }))
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }))
  assert.equal((await openEvents()).length, 2)
  assert.equal((await db.prepare('SELECT count(*) n FROM checkins').get() as { n: number }).n, 2)
})

test('an event is restored when its zone leaves the feed, not when its municipality is missing', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA'), 'SAN JUAN': z('HATO REY SUR') }))
  await processTownsReading(await reading({ 'SAN JUAN': z('HATO REY SUR') })) // CAGUAS not asked: keep open
  assert.equal((await openEvents()).length, 4)
  const r = await reading({ CAGUAS: [], 'SAN JUAN': z('HATO REY SUR') })
  await processTownsReading(r)
  assert.deepEqual((await openEvents()).map((e) => e.patient_id), [3, 4])
  const closed = await db.prepare("SELECT closed_reading_id, closed_at FROM outage_events WHERE status = 'restored'").all() as { closed_reading_id: number; closed_at: string }[]
  assert.equal(closed.length, 2)
  assert.ok(closed.every((c) => c.closed_reading_id === r && c.closed_at))
})

test('a failed reading changes nothing', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }, 0))
  assert.equal((await openEvents()).length, 0)
})

test('every zone in a reading grows the catalogue', async () => {
  await processTownsReading(await reading({ CAGUAS: z('BO NUEVO ZONA TEST') }))
  assert.ok((await knownZones('CAGUAS')).includes('BO NUEVO ZONA TEST'))
  assert.ok((await knownZones('CAGUAS')).includes('URB VILLA BLANCA')) // seed
  assert.deepEqual(await knownZones('PONCE'), [])
})

test('pollOnce in live mode turns a towns reading into events', async () => {
  const f = (async (url: string | URL | Request) => new Response(String(url).endsWith('/towns')
    ? JSON.stringify({ 'SAN JUAN': z('HATO REY SUR') })
    : JSON.stringify({ regions: [], timestamp: 't' }))) as typeof fetch
  await pollOnce(f)
  assert.deepEqual((await openEvents()).map((e) => e.patient_id), [3, 4])
})

test('claimEvent: the first organization wins, the second gets false', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }))
  const [e] = await openEvents()
  assert.equal(await claimEvent(e.id, 2, 3), true)
  assert.equal(await claimEvent(e.id, 1, 2), false)
  const row = (await callList(coord(1))).find((r) => r.eventId === e.id)!
  assert.equal(row.claimedBy, 'Oficina de Emergencias Demo')
})

test('claimEvent refuses an organization that does not cover the patient', async () => {
  await processTownsReading(await reading({ 'SAN JUAN': z('HATO REY SUR') }))
  const [e] = await openEvents()
  assert.equal(await claimEvent(e.id, 2, 3), false) // org 2 covers only CAGUAS
  assert.equal(await claimEvent(e.id, 3, 4), false) // org 3 is pending
  assert.equal(await claimEvent(e.id, 1, 2), true)
})

test("a pending organization's coordinator gets an empty call list", async () => {
  await processTownsReading(await reading({ 'SAN JUAN': z('HATO REY SUR') }))
  assert.equal((await callList(admin)).length, 2)
  assert.deepEqual(await callList(coord(3)), [])
})

test('an organization covering only X never sees a patient in Y', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA'), 'SAN JUAN': z('HATO REY SUR') }))
  assert.deepEqual((await callList(coord(2))).map((r) => r.municipality), ['CAGUAS', 'CAGUAS'])
  assert.equal((await callList(coord(1))).length, 4)
})

test('caregivers get no call list', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }))
  assert.deepEqual(await callList({ role: 'caregiver', orgId: null }), [])
})

test('call list is ranked by the fixed rules', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA', 'CANABONCITO/SEC HORMIGAS') }))
  const p2 = (await openEvents()).find((e) => e.patient_id === 2)!
  await setEventStatus(p2.id, 'confirmed') // insulin → tier 2
  const list = await callList(admin)
  assert.equal(list[0].eventId, p2.id)
  assert.deepEqual(list[0].reasons, ['Sin luz confirmada; insulina en nevera'])
})

test('setEventStatus closes an event and will not reopen it', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }))
  const [e] = await openEvents()
  assert.equal(await setEventStatus(e.id, 'false_alarm'), true)
  assert.ok((await db.prepare('SELECT closed_at FROM outage_events WHERE id = ?').get(e.id) as { closed_at: string }).closed_at)
  assert.equal(await setEventStatus(e.id, 'confirmed'), false)
})

test('coverage gaps list exactly the patients no approved organization covers', async () => {
  assert.deepEqual(await coverageGaps(), []) // seed: CAGUAS and SAN JUAN are both covered
  await assert.rejects(db.tx(async () => {
    await db.exec("DELETE FROM org_municipalities WHERE org_id = 1 AND municipality = 'SAN JUAN'") // only pending org 3 left there
    assert.deepEqual((await coverageGaps()).map((p) => p.id), [3, 4])
    throw new Error('roll back')
  }), /roll back/)
  assert.deepEqual(await coverageGaps(), [])
})

test('processing the same reading twice adds no second check-in', async () => {
  const r = await reading({ CAGUAS: z('URB VILLA BLANCA') })
  await processTownsReading(r)
  await processTownsReading(r) // replay restarted from the same reading
  assert.equal((await db.prepare('SELECT count(*) n FROM checkins').get() as { n: number }).n, 2)
})

test('a closed event cannot be claimed', async () => {
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') }))
  const [e] = await openEvents()
  await setEventStatus(e.id, 'false_alarm')
  assert.equal(await claimEvent(e.id, 1, 2), false)
})

test('replay with a cursor that points at no reading is stale, not fresh', async () => {
  await db.exec("UPDATE settings SET value = 'replay' WHERE key = 'mode'; UPDATE settings SET value = '424242' WHERE key = 'replay_cursor'")
  try {
    assert.deepEqual(await feedStatus(), { lastReadingAt: null, stale: true, mode: 'replay' })
  } finally {
    await db.exec("UPDATE settings SET value = 'live' WHERE key = 'mode'")
  }
})

test('replay and live events never touch each other', async () => {
  const setMode = (m: string) => db.prepare("UPDATE settings SET value = ? WHERE key = 'mode'").run(m)
  await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') })) // live
  const [live] = await openEvents()
  assert.equal(await claimEvent(live.id, 1, 2), true)
  await setMode('replay')
  try {
    await processTownsReading(await reading({ CAGUAS: [], 'SAN JUAN': z('HATO REY SUR') })) // replayed calm CAGUAS
    assert.equal((await db.prepare('SELECT status FROM outage_events WHERE id = ?').get(live.id) as { status: string }).status, 'possible')
    assert.deepEqual((await callList(admin)).map((r) => r.municipality), ['SAN JUAN', 'SAN JUAN'])
  } finally {
    await setMode('live')
  }
  assert.deepEqual((await callList(admin)).map((r) => r.municipality), ['CAGUAS', 'CAGUAS'])
})

test('only events of the current mode can be claimed', async () => {
  await db.exec("UPDATE settings SET value = 'replay' WHERE key = 'mode'")
  try {
    await processTownsReading(await reading({ CAGUAS: z('URB VILLA BLANCA') })) // replay event
  } finally {
    await db.exec("UPDATE settings SET value = 'live' WHERE key = 'mode'")
  }
  const [e] = await openEvents()
  assert.equal(await claimEvent(e.id, 1, 2), false) // hidden from the live call list
})
