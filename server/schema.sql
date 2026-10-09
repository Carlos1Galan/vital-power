-- VitalPower Relay schema (Docs/architecture.md §3). Shared file: change only at a sync point.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('responder','facility')),
  org_type      TEXT NOT NULL CHECK (org_type IN ('health-plan','municipality','clinic','supplier','care-home','other')),
  contact_email TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_by   INTEGER REFERENCES users(id),
  reviewed_at   TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  role   TEXT NOT NULL CHECK (role IN ('caregiver','coordinator','admin')),
  org_id INTEGER REFERENCES organizations(id)
);

CREATE TABLE IF NOT EXISTS org_municipalities (
  org_id       INTEGER NOT NULL REFERENCES organizations(id),
  municipality TEXT NOT NULL,
  PRIMARY KEY (org_id, municipality)
);

CREATE TABLE IF NOT EXISTS patients (
  id              INTEGER PRIMARY KEY,
  caregiver_id    INTEGER NOT NULL REFERENCES users(id),
  facility_id     INTEGER REFERENCES organizations(id),
  is_self         INTEGER NOT NULL DEFAULT 0,
  display_name    TEXT NOT NULL,
  phone           TEXT,
  municipality    TEXT NOT NULL,
  zone            TEXT,
  consent_at      TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  confirmed_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_self_patient ON patients(caregiver_id) WHERE is_self = 1;
CREATE INDEX IF NOT EXISTS patients_place ON patients(municipality, zone);

CREATE TABLE IF NOT EXISTS patient_needs (
  patient_id    INTEGER NOT NULL REFERENCES patients(id),
  kind          TEXT NOT NULL CHECK (kind IN ('oxygen','cpap','ventilator','dialysis','insulin','other')),
  battery_hours REAL
);

CREATE TABLE IF NOT EXISTS intakes (
  id           INTEGER PRIMARY KEY,
  caregiver_id INTEGER NOT NULL REFERENCES users(id),
  patient_id   INTEGER REFERENCES patients(id),
  transcript   TEXT NOT NULL,
  ai_json      TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','rejected'))
);

CREATE TABLE IF NOT EXISTS zones (
  municipality TEXT NOT NULL,
  zone         TEXT NOT NULL,
  PRIMARY KEY (municipality, zone)
);

-- Every LUMA reading, failures included. ok = 1 only when the payload parsed.
CREATE TABLE IF NOT EXISTS luma_readings (
  id             INTEGER PRIMARY KEY,
  fetched_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source         TEXT NOT NULL DEFAULT 'live' CHECK (source IN ('live','replay')),
  endpoint       TEXT NOT NULL CHECK (endpoint IN ('regions','towns')),
  request_body   TEXT,
  http_status    INTEGER NOT NULL, -- 0 = no response (timeout, network)
  ok             INTEGER NOT NULL,
  error          TEXT,
  payload        TEXT,
  luma_timestamp TEXT
);

CREATE TABLE IF NOT EXISTS outage_events (
  id                INTEGER PRIMARY KEY,
  patient_id        INTEGER NOT NULL REFERENCES patients(id),
  opened_reading_id INTEGER NOT NULL REFERENCES luma_readings(id),
  closed_reading_id INTEGER REFERENCES luma_readings(id),
  status            TEXT NOT NULL DEFAULT 'possible' CHECK (status IN ('possible','confirmed','restored','false_alarm')),
  opened_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at         TEXT,
  claimed_by_org_id INTEGER REFERENCES organizations(id),
  claimed_by        INTEGER REFERENCES users(id),
  claimed_at        TEXT
);
-- One open incident per patient.
CREATE UNIQUE INDEX IF NOT EXISTS one_open_event ON outage_events(patient_id) WHERE status IN ('possible','confirmed');

CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES outage_events(id),
  sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  message      TEXT NOT NULL,
  reply_text   TEXT,
  reply_at     TEXT,
  ai_parsed    TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS briefings (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES outage_events(id),
  draft_text    TEXT NOT NULL,
  approved_text TEXT,
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT
);

CREATE TABLE IF NOT EXISTS call_outcomes (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES outage_events(id),
  coordinator_id INTEGER NOT NULL REFERENCES users(id),
  reached        INTEGER NOT NULL,
  outcome        TEXT NOT NULL,
  next_action    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('mode', 'live'), ('replay_cursor', '0');
