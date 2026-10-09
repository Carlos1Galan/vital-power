import { z } from 'zod'
import { db } from './db.ts'
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
  return { regionsId, townsId }
}
