import { z } from 'zod'
import { db, setSetting, setting } from './db.ts'
import { processTownsReading } from './events.ts'
import { MUNICIPALITIES } from './municipalities.ts'

export const POLL_MS = 180_000 // LUMA's own client refresh interval; polling faster returns nothing fresher.
const BASE = 'https://api.miluma.lumapr.com/miluma-outage-api/outage'
// Without a browser User-Agent, LUMA's Incapsula bot wall answers 403 with HTML.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'

const Regions = z.looseObject({
  regions: z.array(z.looseObject({ name: z.string(), totalClients: z.number(), totalClientsWithoutService: z.number() })),
  timestamp: z.string(),
})
export const Towns = z.record(z.string(), z.array(z.looseObject({ zone: z.string(), area: z.string() })))

// Fetches one endpoint and stores the reading, failures included. ok = 1 only when the payload parsed.
async function read(endpoint: 'regions' | 'towns', init: RequestInit, schema: z.ZodType, f: typeof fetch) {
  let http_status = 0, ok = 0, error: string | null = null, payload: string | null = null, luma_timestamp: string | null = null
  try {
    const res = await f(`${BASE}/${endpoint === 'regions' ? 'regionsWithoutService' : 'municipality/towns'}`, {
      ...init,
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    http_status = res.status
    payload = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed = schema.parse(JSON.parse(payload)) as { timestamp?: string }
    luma_timestamp = parsed.timestamp ?? null
    ok = 1
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
  }
  return Number(db.prepare(
    'INSERT INTO luma_readings (endpoint, request_body, http_status, ok, error, payload, luma_timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(endpoint, (init.body as string) ?? null, http_status, ok, error, payload, luma_timestamp).lastInsertRowid)
}

// One poll: region counts plus affected zones for all 78 municipalities (one POST, same cost as one town).
export async function pollOnce(f: typeof fetch = fetch) {
  const regionsId = await read('regions', { method: 'GET' }, Regions, f)
  const townsId = await read('towns', { method: 'POST', body: JSON.stringify(MUNICIPALITIES) }, Towns, f)
  // In replay the live feed is still recorded, but only the replayed readings drive events.
  if (setting('mode') === 'live') processTownsReading(townsId)
  return { regionsId, townsId }
}

// Replay walks the recorded live towns readings in id order. The cursor is the reading being shown.
const nextRecorded = (afterId: number) =>
  (db.prepare("SELECT id FROM luma_readings WHERE source = 'live' AND endpoint = 'towns' AND ok = 1 AND id > ? ORDER BY id LIMIT 1")
    .get(afterId) as { id: number } | undefined)?.id ?? null

// false = fromReadingId is not a recorded towns reading.
export function setMode(mode: 'live' | 'replay', fromReadingId?: number) {
  if (mode === 'live') {
    setSetting('mode', 'live')
    return true
  }
  const start = nextRecorded((fromReadingId ?? 1) - 1)
  if (!start || (fromReadingId && start !== fromReadingId)) return false
  setSetting('mode', 'replay')
  setSetting('replay_cursor', String(start))
  processTownsReading(start)
  return true
}

// One replay step: the next recorded reading drives events. null = end of the recording.
export function replayStep() {
  const next = nextRecorded(Number(setting('replay_cursor')))
  if (next) {
    setSetting('replay_cursor', String(next))
    processTownsReading(next)
  }
  return next
}

export function startPoller() {
  const tick = () => pollOnce().catch((e) => console.error('poll failed', e))
  tick()
  return setInterval(tick, POLL_MS)
}
