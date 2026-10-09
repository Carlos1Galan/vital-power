import { db, setting } from './db.ts'
import { POLL_MS } from './luma.ts'

type Reading = { id: number; fetched_at: string; ok: number }

// Shared by every response: { lastReadingAt, stale, mode }. Replay is labeled by mode, never stale.
export function feedStatus(now = Date.now()) {
  const mode = setting('mode') as 'live' | 'replay'
  if (mode === 'replay') {
    const r = db.prepare('SELECT fetched_at FROM luma_readings WHERE id = ?').get(Number(setting('replay_cursor'))) as Reading | undefined
    return { lastReadingAt: r?.fetched_at ?? null, stale: false, mode }
  }
  const last = db.prepare("SELECT ok FROM luma_readings WHERE source = 'live' ORDER BY id DESC LIMIT 1").get() as Reading | undefined
  const good = db.prepare("SELECT fetched_at FROM luma_readings WHERE source = 'live' AND ok = 1 ORDER BY id DESC LIMIT 1").get() as Reading | undefined
  const lastReadingAt = good?.fetched_at ?? null
  const stale = !lastReadingAt || !last?.ok || now - Date.parse(lastReadingAt) > 2 * POLL_MS
  return { lastReadingAt, stale, mode }
}
