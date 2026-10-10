import { db, setting } from './db.ts'
import { rank, type RankInput } from './priority.ts'
import { POLL_MS } from './luma.ts'

type Reading = { id: number; fetched_at: string; ok: number }

// Shared by every response: { lastReadingAt, stale, mode }. Replay is labeled by mode; stale only if its reading is gone.
export async function feedStatus(now = Date.now()) {
  const mode = await setting('mode') as 'live' | 'replay'
  if (mode === 'replay') {
    const r = await db.prepare('SELECT fetched_at FROM luma_readings WHERE id = ?').get(Number(await setting('replay_cursor'))) as Reading | undefined
    return { lastReadingAt: r?.fetched_at ?? null, stale: !r, mode }
  }
  // Per endpoint: a failing regions call must not hide behind a working towns call (or the reverse).
  let lastReadingAt: string | null = null, stale = false
  for (const endpoint of ['regions', 'towns']) {
    const last = await db.prepare("SELECT ok FROM luma_readings WHERE source = 'live' AND endpoint = ? ORDER BY id DESC LIMIT 1").get(endpoint) as Reading | undefined
    const good = await db.prepare("SELECT fetched_at FROM luma_readings WHERE source = 'live' AND endpoint = ? AND ok = 1 ORDER BY id DESC LIMIT 1").get(endpoint) as Reading | undefined
    if (!good || !last?.ok || now - Date.parse(good.fetched_at) > 2 * POLL_MS) stale = true
    if (good && (!lastReadingAt || good.fetched_at < lastReadingAt)) lastReadingAt = good.fetched_at // the older of the two
  }
  return { lastReadingAt, stale, mode }
}

export const CHECKIN_MESSAGE = '¿Tiene luz en su casa?'

// The municipalities of a towns reading (the keys are the names we asked for), and every (municipality, zone) pair in it.
const TOWNS = 'json_each((SELECT payload::json FROM luma_readings WHERE id = :id))'
const ZONES_IN = `SELECT m.key AS municipality, z.value->>'zone' AS zone FROM ${TOWNS} m, json_array_elements(m.value) z`

// Handoff to B: a patient's zone in the feed opens a `possible` event plus its check-in.
// An open event is restored when its zone leaves the feed (only if the reading covered its municipality).
export async function processTownsReading(id: number) {
  const r = await db.prepare("SELECT ok FROM luma_readings WHERE id = ? AND endpoint = 'towns'").get(id) as Reading | undefined
  if (!r?.ok) return
  const mode = await setting('mode') // replay readings open and close only replay events
  await db.tx(async () => {
    await db.prepare(`INSERT INTO zones (municipality, zone) ${ZONES_IN} ON CONFLICT DO NOTHING`).run({ id })
    await db.prepare(`INSERT INTO outage_events (patient_id, opened_reading_id, mode)
      SELECT p.id, :id, :mode FROM patients p
      WHERE (p.municipality, p.zone) IN (${ZONES_IN})
        AND NOT EXISTS (SELECT 1 FROM outage_events e WHERE e.patient_id = p.id AND e.mode = :mode AND e.status IN ('possible','confirmed'))`).run({ id, mode })
    await db.prepare(`INSERT INTO checkins (event_id, message) SELECT e.id, ? FROM outage_events e
      WHERE e.opened_reading_id = ? AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.event_id = e.id)`).run(CHECKIN_MESSAGE, id)
    await db.prepare(`UPDATE outage_events SET status = 'restored', closed_reading_id = :id, closed_at = iso(now())
      WHERE status IN ('possible','confirmed') AND mode = :mode AND patient_id IN (
        SELECT p.id FROM patients p
        WHERE p.municipality IN (SELECT m.key FROM ${TOWNS} m)
          AND (p.municipality, p.zone) NOT IN (${ZONES_IN}))`).run({ id, mode })
  })
}

export const knownZones = async (municipality: string) =>
  (await db.prepare('SELECT zone FROM zones WHERE municipality = ? ORDER BY zone').all(municipality) as { zone: string }[]).map((z) => z.zone)

// Called by B's confirm route. Only open events change, so a closed event is never reopened.
export async function setEventStatus(eventId: number, status: 'possible' | 'confirmed' | 'restored' | 'false_alarm') {
  return (await db.prepare(`UPDATE outage_events SET status = :status,
      closed_at = CASE WHEN :status::text IN ('restored','false_alarm') THEN iso(now()) END
    WHERE id = :eventId AND status IN ('possible','confirmed')`).run({ status, eventId })).changes > 0
}

// Municipalities an organization may act in: only an approved responder has any.
const COVERED_BY = `SELECT om.municipality FROM org_municipalities om JOIN organizations o ON o.id = om.org_id
  WHERE o.id = :orgId AND o.kind = 'responder' AND o.status = 'approved'`

// One conditional UPDATE: the database decides the race. false = already claimed, or not this org's to claim.
export async function claimEvent(eventId: number, orgId: number, userId: number) {
  return (await db.prepare(`UPDATE outage_events SET claimed_by_org_id = :orgId, claimed_by = :userId, claimed_at = iso(now())
    WHERE id = :eventId AND claimed_by_org_id IS NULL AND status IN ('possible','confirmed')
      AND mode = (SELECT value FROM settings WHERE key = 'mode') -- only what the call list shows
      AND (SELECT municipality FROM patients WHERE id = outage_events.patient_id) IN (${COVERED_BY})`)
    .run({ eventId, orgId, userId })).changes > 0
}

// A patient's needs as a JSON text array, '[]' when none (json_agg alone gives NULL over no rows).
export const NEEDS = `(SELECT COALESCE(json_agg(json_build_object('kind', kind, 'batteryHours', battery_hours)), '[]')::text
  FROM patient_needs WHERE patient_id = p.id)`

export type Viewer = { role: 'admin' | 'coordinator' | 'caregiver'; orgId: number | null }

type CallRow = Omit<RankInput, 'needs'> & {
  needs: string; patientId: number; patientName: string; municipality: string; zone: string
  claimedByOrgId: number | null; claimedBy: string | null
}

// Open events the viewer may see, ranked per request (never stored). Scope lives in the SQL.
export async function callList(viewer: Viewer) {
  if (viewer.role === 'caregiver') return []
  const rows = await db.prepare(`SELECT e.id AS eventId, e.status, e.opened_at AS openedAt,
      p.id AS patientId, p.display_name AS patientName, p.municipality, p.zone,
      ${NEEDS} AS needs,
      c.sent_at AS checkinSentAt, c.reply_at AS checkinReplyAt,
      e.claimed_by_org_id AS claimedByOrgId, o.name AS claimedBy
    FROM outage_events e
    JOIN patients p ON p.id = e.patient_id
    LEFT JOIN organizations o ON o.id = e.claimed_by_org_id
    LEFT JOIN checkins c ON c.id = (SELECT max(id) FROM checkins WHERE event_id = e.id)
    WHERE e.status IN ('possible','confirmed') AND e.mode = :mode
      AND (:all = 1 OR p.municipality IN (${COVERED_BY}))`)
    .all({ all: viewer.role === 'admin' ? 1 : 0, orgId: viewer.orgId, mode: await setting('mode') }) as CallRow[]
  return rank(rows.map((r) => ({ ...r, needs: JSON.parse(r.needs) as RankInput['needs'] })))
}

// Patients in municipalities no approved responder covers: who would get no call today.
export const coverageGaps = async () =>
  await db.prepare(`SELECT id, display_name AS name, municipality, zone FROM patients
    WHERE municipality NOT IN (SELECT om.municipality FROM org_municipalities om JOIN organizations o ON o.id = om.org_id
      WHERE o.kind = 'responder' AND o.status = 'approved')
    ORDER BY id`).all() as { id: number; name: string; municipality: string; zone: string | null }[]
