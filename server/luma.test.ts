import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { db } from './db.ts'
import { pollOnce, POLL_MS } from './luma.ts'
import { feedStatus } from './events.ts'

const regionsJson = JSON.stringify({ regions: [{ name: 'Caguas', totalClients: 10, totalClientsWithoutService: 1 }], timestamp: '10/09/2026 09:20 AM' })
const townsJson = JSON.stringify({ CAGUAS: [{ zone: 'URB VILLA BLANCA', area: 'CAGUAS' }] })

// Fake fetch: answers by endpoint, so one poll stores one regions and one towns reading.
const fake = (regions: () => Response | Promise<Response>, towns = regions) =>
  (async (url: string | URL | Request) => (String(url).endsWith('/towns') ? towns() : regions())) as typeof fetch

const html = (status: number) => () => new Response('<html>Incapsula</html>', { status, headers: { 'content-type': 'text/html' } })
const lastReadings = () => db.prepare('SELECT endpoint, http_status, ok, error FROM luma_readings ORDER BY id DESC LIMIT 2').all() as { endpoint: string; http_status: number; ok: number; error: string | null }[]

beforeEach(() => db.exec("DELETE FROM checkins; DELETE FROM outage_events; DELETE FROM luma_readings; UPDATE settings SET value = 'live' WHERE key = 'mode'"))

test('a parsed payload is stored as ok and the feed is fresh', async () => {
  await pollOnce(fake(() => new Response(regionsJson), () => new Response(townsJson)))
  const rows = lastReadings()
  assert.deepEqual(rows.map((r) => [r.endpoint, r.http_status, r.ok]), [['towns', 200, 1], ['regions', 200, 1]])
  const s = feedStatus()
  assert.equal(s.stale, false)
  assert.equal(s.mode, 'live')
  assert.ok(s.lastReadingAt)
})

for (const [name, f] of [
  ['bot wall: 403 with HTML', fake(html(403))],
  ['200 with an HTML body', fake(html(200))],
  ['500 on an unknown town', fake(() => new Response('{"error":"x"}', { status: 500 }))],
  ['timeout', fake(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')))],
] as const) {
  test(`${name} is stored as failed and makes the feed stale`, async () => {
    await pollOnce(fake(() => new Response(regionsJson), () => new Response(townsJson)))
    await pollOnce(f)
    for (const r of lastReadings()) {
      assert.equal(r.ok, 0)
      assert.ok(r.error)
    }
    assert.equal(feedStatus().stale, true)
  })
}

test('a timeout is stored with http_status 0', async () => {
  await pollOnce(fake(() => Promise.reject(new DOMException('timed out', 'TimeoutError'))))
  assert.equal(lastReadings()[0].http_status, 0)
})

test('the feed is stale when the last good reading is older than 2x the poll interval', async () => {
  await pollOnce(fake(() => new Response(regionsJson), () => new Response(townsJson)))
  assert.equal(feedStatus(Date.now() + 2 * POLL_MS - 1000).stale, false)
  assert.equal(feedStatus(Date.now() + 2 * POLL_MS + 1000).stale, true)
})

test('no reading at all is stale', () => {
  assert.deepEqual(feedStatus(), { lastReadingAt: null, stale: true, mode: 'live' })
})
