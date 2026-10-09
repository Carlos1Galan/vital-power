import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { app } from './app.ts'

const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as any }
}
const towns = (payload: object) =>
  Number(db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload) VALUES ('towns', 200, 1, ?)").run(JSON.stringify(payload)).lastInsertRowid)
const regions = (without: number) =>
  db.prepare("INSERT INTO luma_readings (endpoint, http_status, ok, payload, luma_timestamp) VALUES ('regions', 200, 1, ?, 't')")
    .run(JSON.stringify({ regions: [{ name: 'Caguas', totalClients: 100, totalClientsWithoutService: without }], timestamp: 't' }))
const feedKeys = (j: object) => assert.deepEqual(['lastReadingAt', 'mode', 'stale'].filter((k) => k in j), ['lastReadingAt', 'mode', 'stale'])
const org = { name: 'Clínica Demo', orgType: 'clinic', contactEmail: 'demo@example.org', municipalities: ['CAGUAS', 'AÑASCO'], message: 'hola' }

beforeEach(() => db.exec("DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings; UPDATE settings SET value = 'live' WHERE key = 'mode'"))

test('GET /public/status returns the latest region counts and the feed status', async () => {
  regions(5)
  regions(7)
  const { status, json } = await call('GET', '/public/status')
  assert.equal(status, 200)
  feedKeys(json)
  assert.equal(json.regions[0].totalClientsWithoutService, 7)
})

test('POST /public/organizations stores a pending responder with its municipalities', async () => {
  const { status, json } = await call('POST', '/public/organizations', org)
  assert.equal(status, 201)
  feedKeys(json)
  const row = db.prepare('SELECT kind, status FROM organizations WHERE id = ?').get(json.id) as { kind: string; status: string }
  assert.deepEqual({ ...row }, { kind: 'responder', status: 'pending' })
  const munis = db.prepare('SELECT municipality FROM org_municipalities WHERE org_id = ? ORDER BY municipality').all(json.id) as { municipality: string }[]
  assert.deepEqual(munis.map((m) => m.municipality), ['AÑASCO', 'CAGUAS'])
})

test('POST /public/organizations rejects bad input', async () => {
  assert.equal((await call('POST', '/public/organizations', { ...org, municipalities: ['Caguas'] })).status, 400) // LUMA spelling only
  assert.equal((await call('POST', '/public/organizations', { ...org, municipalities: [] })).status, 400)
  assert.equal((await call('POST', '/public/organizations', { ...org, contactEmail: 'nope' })).status, 400)
  assert.equal((await call('POST', '/public/organizations', { ...org, orgType: 'care-home' })).status, 400) // facilities are not responders
  assert.equal((await call('POST', '/public/organizations', JSON.stringify({ ...org, message: 'x'.repeat(20_000) }))).status, 413)
})

test('admin reviews a pending organization', async () => {
  const list = await call('GET', '/admin/organizations')
  const pending = list.json.organizations.find((o: any) => o.status === 'pending')
  assert.deepEqual(pending.municipalities, ['SAN JUAN'])
  assert.equal((await call('POST', `/admin/organizations/${pending.id}/review`, { decision: 'approve' })).status, 200)
  assert.equal((db.prepare('SELECT status FROM organizations WHERE id = ?').get(pending.id) as { status: string }).status, 'approved')
  assert.equal((await call('POST', '/admin/organizations/4/review', { decision: 'approve' })).status, 404) // a facility
  assert.equal((await call('POST', `/admin/organizations/${pending.id}/review`, { decision: 'maybe' })).status, 400)
  db.prepare("UPDATE organizations SET status = 'pending', reviewed_at = NULL WHERE id = ?").run(pending.id)
})

test('GET /admin/coverage-gaps and /admin/readings', async () => {
  const gaps = await call('GET', '/admin/coverage-gaps')
  assert.deepEqual(gaps.json.patients, [])
  feedKeys(gaps.json)
  towns({ CAGUAS: [] })
  const r = await call('GET', '/admin/readings')
  assert.equal(r.json.readings[0].http_status, 200)
  assert.equal('payload' in r.json.readings[0], false)
})

test('GET /call-list returns ranked events with reasons and claimedBy', async () => {
  const id = towns({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'CAGUAS' }] })
  await call('PUT', '/admin/mode', { mode: 'replay', fromReadingId: id }) // processes the reading
  const { json } = await call('GET', '/call-list')
  feedKeys(json)
  assert.equal(json.events.length, 2)
  assert.ok(json.events[0].reasons.length)
  assert.equal(json.events[0].claimedBy, null)
})

test('replay walks stored readings in order and every response says replay', async () => {
  const empty = towns({ CAGUAS: [] })
  const out = towns({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'CAGUAS' }] })
  const back = towns({ CAGUAS: [] })
  const open = () => (db.prepare("SELECT count(*) n FROM outage_events WHERE status = 'possible'").get() as { n: number }).n

  assert.equal((await call('PUT', '/admin/mode', { mode: 'replay', fromReadingId: 999_999 })).status, 400)
  const m = await call('PUT', '/admin/mode', { mode: 'replay', fromReadingId: empty })
  assert.equal(m.json.mode, 'replay')
  assert.equal(open(), 0)

  const step1 = await call('POST', '/admin/poll')
  assert.equal(step1.json.readingId, out)
  assert.equal(open(), 2)
  assert.equal((await call('GET', '/public/status')).json.mode, 'replay')
  assert.equal((await call('GET', '/call-list')).json.mode, 'replay')

  assert.equal((await call('POST', '/admin/poll')).json.readingId, back)
  assert.equal(open(), 0)
  assert.equal((await call('POST', '/admin/poll')).json.readingId, null) // end of the recording

  assert.equal((await call('PUT', '/admin/mode', { mode: 'live' })).json.mode, 'live')
})

test('validation errors come back as a string, so the UI can show them', async () => {
  const r = await call('PUT', '/admin/mode', { mode: 'replay', fromReadingId: 0 })
  assert.equal(r.status, 400)
  assert.equal(typeof r.json.error, 'string')
  feedKeys(r.json)
})
