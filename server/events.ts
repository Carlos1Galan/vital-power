import { db, setting } from './db.ts'
import { rank, type RankInput } from './priority.ts'
import { POLL_MS } from './luma.ts'

type Reading = { id: number; fetched_at: string; ok: number }

// Shared by every response: { lastReadingAt, stale, mode }. Replay is labeled by mode; stale only if its reading is gone.
export function feedStatus(now = Date.now()) {
  const mode = setting('mode') as 'live' | 'replay'
  if (mode === 'replay') {
    const r = db.prepare('SELECT fetched_at FROM luma_readings WHERE id = ?').get(Number(setting('replay_cursor'))) as Reading | undefined
    return { lastReadingAt: r?.fetched_at ?? null, stale: !r, mode }
  }
  // Per endpoint: a failing regions call must not hide behind a working towns call (or the reverse).
  let lastReadingAt: string | null = null, stale = false
  for (const endpoint of ['regions', 'towns']) {
    const last = db.prepare("SELECT ok FROM luma_readings WHERE source = 'live' AND endpoint = ? ORDER BY id DESC LIMIT 1").get(endpoint) as Reading | undefined
    const good = db.prepare("SELECT fetched_at FROM luma_readings WHERE source = 'live' AND endpoint = ? AND ok = 1 ORDER BY id DESC LIMIT 1").get(endpoint) as Reading | undefined
    if (!good || !last?.ok || now - Date.parse(good.fetched_at) > 2 * POLL_MS) stale = true
    if (good && (!lastReadingAt || good.fetched_at < lastReadingAt)) lastReadingAt = good.fetched_at // the older of the two
  }
  return { lastReadingAt, stale, mode }
}

export const CHECKIN_MESSAGE = '¿Tiene luz en su casa?'

const tx = (fn: () => void) => {
  db.exec('BEGIN')
  try { fn(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
}

// Every (municipality, zone) pair in a towns reading. Keys are the municipality names we asked for.
const ZONES_IN = `SELECT m.key AS municipality, json_extract(z.value, '$.zone') AS zone
  FROM luma_readings r, json_each(r.payload) m, json_each(m.value) z WHERE r.id = :id`

// Handoff to B: a patient's zone in the feed opens a `possible` event plus its check-in.
// An open event is restored when its zone leaves the feed (only if the reading covered its municipality).
export function processTownsReading(id: number) {
  const r = db.prepare("SELECT ok FROM luma_readings WHERE id = ? AND endpoint = 'towns'").get(id) as Reading | undefined
  if (!r?.ok) return
  const mode = setting('mode') // replay readings open and close only replay events
  tx(() => {
    db.prepare(`INSERT OR IGNORE INTO zones (municipality, zone) ${ZONES_IN}`).run({ id })
    db.prepare(`INSERT INTO outage_events (patient_id, opened_reading_id, mode)
      SELECT p.id, :id, :mode FROM patients p
      WHERE (p.municipality, p.zone) IN (${ZONES_IN})
        AND NOT EXISTS (SELECT 1 FROM outage_events e WHERE e.patient_id = p.id AND e.mode = :mode AND e.status IN ('possible','confirmed'))`).run({ id, mode })
    db.prepare(`INSERT INTO checkins (event_id, message) SELECT e.id, ? FROM outage_events e
      WHERE e.opened_reading_id = ? AND NOT EXISTS (SELECT 1 FROM checkins c WHERE c.event_id = e.id)`).run(CHECKIN_MESSAGE, id)
    db.prepare(`UPDATE outage_events SET status = 'restored', closed_reading_id = :id, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status IN ('possible','confirmed') AND mode = :mode AND patient_id IN (
        SELECT p.id FROM patients p
        WHERE p.municipality IN (SELECT m.key FROM luma_readings r, json_each(r.payload) m WHERE r.id = :id)
          AND (p.municipality, p.zone) NOT IN (${ZONES_IN}))`).run({ id, mode })
  })
}

export const knownZones = (municipality: string) =>
  (db.prepare('SELECT zone FROM zones WHERE municipality = ? ORDER BY zone').all(municipality) as { zone: string }[]).map((z) => z.zone)

// Called by B's confirm route. Only open events change, so a closed event is never reopened.
export function setEventStatus(eventId: number, status: 'possible' | 'confirmed' | 'restored' | 'false_alarm') {
  return db.prepare(`UPDATE outage_events SET status = :status,
      closed_at = CASE WHEN :status IN ('restored','false_alarm') THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') END
    WHERE id = :eventId AND status IN ('possible','confirmed')`).run({ status, eventId }).changes > 0
}

// Municipalities an organization may act in: only an approved responder has any.
const COVERED_BY = `SELECT om.municipality FROM org_municipalities om JOIN organizations o ON o.id = om.org_id
  WHERE o.id = :orgId AND o.kind = 'responder' AND o.status = 'approved'`

// One conditional UPDATE: the database decides the race. false = already claimed, or not this org's to claim.
export function claimEvent(eventId: number, orgId: number, userId: number) {
  return db.prepare(`UPDATE outage_events SET claimed_by_org_id = :orgId, claimed_by = :userId, claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = :eventId AND claimed_by_org_id IS NULL AND status IN ('possible','confirmed')
      AND (SELECT municipality FROM patients WHERE id = outage_events.patient_id) IN (${COVERED_BY})`)
    .run({ eventId, orgId, userId }).changes > 0
}

export type Viewer = { role: 'admin' | 'coordinator' | 'caregiver'; orgId: number | null }

type CallRow = Omit<RankInput, 'needs'> & {
  needs: string; patientId: number; patientName: string; municipality: string; zone: string
  claimedByOrgId: number | null; claimedBy: string | null
}

// Open events the viewer may see, ranked per request (never stored). Scope lives in the SQL.
export function callList(viewer: Viewer) {
  if (viewer.role === 'caregiver') return []
  const rows = db.prepare(`SELECT e.id AS eventId, e.status, e.opened_at AS openedAt,
      p.id AS patientId, p.display_name AS patientName, p.municipality, p.zone,
      (SELECT json_group_array(json_object('kind', kind, 'batteryHours', battery_hours)) FROM patient_needs WHERE patient_id = p.id) AS needs,
      c.sent_at AS checkinSentAt, c.reply_at AS checkinReplyAt,
      e.claimed_by_org_id AS claimedByOrgId, o.name AS claimedBy
    FROM outage_events e
    JOIN patients p ON p.id = e.patient_id
    LEFT JOIN organizations o ON o.id = e.claimed_by_org_id
    LEFT JOIN checkins c ON c.id = (SELECT max(id) FROM checkins WHERE event_id = e.id)
    WHERE e.status IN ('possible','confirmed') AND e.mode = :mode
      AND (:all = 1 OR p.municipality IN (${COVERED_BY}))`)
    .all({ all: viewer.role === 'admin' ? 1 : 0, orgId: viewer.orgId, mode: setting('mode') }) as CallRow[]
  return rank(rows.map((r) => ({ ...r, needs: JSON.parse(r.needs) as RankInput['needs'] })))
}

// Patients in municipalities no approved responder covers: who would get no call today.
export const coverageGaps = () =>
  db.prepare(`SELECT id, display_name AS name, municipality, zone FROM patients
    WHERE municipality NOT IN (SELECT om.municipality FROM org_municipalities om JOIN organizations o ON o.id = om.org_id
      WHERE o.kind = 'responder' AND o.status = 'approved')
    ORDER BY id`).all() as { id: number; name: string; municipality: string; zone: string | null }[]
