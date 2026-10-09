# VitalPower Relay: evaluation and architecture proposal

## Context

`Docs/vitalpower-relay.md` defines the product. The repo is still the stock Vite `react-ts` template (React 19, Vite 8, TS 6, Node 24.21). The user asked for an evaluation of the idea plus a proposal for the database, user area, admin area, landing page, API endpoints, and a typed way for the React app to talk to the API inside the same project.

Choices the user made: typed API client (Hono RPC); landing page aimed at **judges and pilot partners**; **seeded demo accounts**; **design doc only**. Devpost rules forbid app code before Oct 8, so the deliverable today is **one new file, `Docs/architecture.md`**, containing the sections below. No code, no `package.json` changes until kickoff.

---

## 1. Evaluation of the idea (goes first in the doc)

**Verdict: build it.** The problem is real and documented, the data source is live and public, and the human-in-the-loop design answers the first question judges ask about AI in healthcare.

| Dimension | Assessment |
|---|---|
| Problem | Strong. CPI: PR Health Dept has refused to build the list (2024, 2025 reporting). |
| Novelty | Strong, once positioned against HHS emPOWER (below). |
| Feasibility in 48 h | Good with the cuts already in the spec. Riskiest piece: zone matching. |
| Business case | Must be named explicitly; the spec has none yet. |

**Findings to add to the pitch:**

1. **emPOWER is the comparison judges will raise.** HHS emPOWER already maps 40,000+ electricity-dependent people in PR, but only **Medicare** beneficiaries, de-identified, at ZIP level. It excludes **Plan Vital** (PR's public plan) and private insurers. Pitch line: *"emPOWER tells you how many. VitalPower tells you who to call first."*
2. **Name collision.** "VitalPower" sits next to "Plan Vital". Either rename before Devpost submission or use it: Plan Vital MCOs are the natural buyer for the uncovered population.
3. **Buyer and outcome** (missing from the spec):
   - Plan Vital MCOs / ASES: **reduce cost** by avoiding ER visits and admissions from failed oxygen or spoiled insulin.
   - Municipal emergency management: **mitigate risk**, since a defensible list exists before the next hurricane.
4. **Unconventional channel:** register patients through **oxygen/DME suppliers**. They already know every concentrator user, have a consent relationship, and deliver the equipment. Registration becomes one onboarding step instead of a cold start with caregivers.
5. **Gaps to state honestly:**
   - LUMA only returns *affected* zones, so there is no full zone catalogue for address matching. The catalogue is built from every zone seen in stored readings plus a manual seed for the 2 demo municipalities.
   - Planned outage and load-shedding counts exist only at region level, so they cannot be attributed to a zone. They are shown as context, not used as a priority rule.
   - Real use with health data triggers HIPAA once a covered entity (MCO, clinic) operates it. The demo stays synthetic.

---

## 2. Architecture: one package, two processes in dev

```
server/            Node 24 runs .ts directly (type stripping; matches erasableSyntaxOnly)
  main.ts          start Hono on :3000, serve dist/ in prod, start LUMA poller
  app.ts           all routes; export type AppType = typeof app
  db.ts            node:sqlite (built-in, no driver dep), runs schema.sql + seed
  schema.sql
  luma.ts          fetch both endpoints, store raw, poll every 3 min, replay mode
  priority.ts      pure ranking rules → { tier, reasons[] }
  priority.test.ts node --test assertions (the one runnable check)
  ai.ts            3 Claude calls: extract profile, parse reply, draft briefing
src/
  api.ts           export const api = hc<AppType>('/')   ← the typed client
  App.tsx          pathname switch: / → Landing, /app → Caregiver, /admin → Admin
  Landing.tsx  Caregiver.tsx  Admin.tsx
```

- **How the frontend talks to the API:** Hono RPC. `src/api.ts` imports only the *type* of the server app (`import type { AppType }`), so a renamed route or changed body breaks `npm run build`. Vite's built-in `server.proxy` sends `/api` to `:3000` in dev; in prod Hono serves `dist/` itself, so it is always one origin and needs no CORS.
- **Scripts:** `dev` (vite) and `api` (`node --watch server/main.ts`). Add `server` to `tsconfig.node.json` `include`.
- **New deps (5):** `hono`, `@hono/node-server`, `zod` (input validation at every trust boundary + Claude output schemas), `@hono/zod-validator`, `@anthropic-ai/sdk`.
- **Deliberately not added:**
  - React Router: 3 areas means a pathname switch.
  - ORM: about 10 tables, plain SQL.
  - Real authentication: the demo has no passwords. A "Ver como" persona switcher sets a cookie with the user id (§4, Demo login), so the app holds synthetic data only.
  - SMS provider: check-ins are answered in the caregiver area; add Twilio after the hackathon.
- **Voice:** browser Web Speech API (`lang: 'es-PR'`) produces a transcript, then Claude extracts the profile. A textarea fallback covers browsers without speech recognition.
- **AI model:** `claude-sonnet-5-5` with structured output validated by zod. Zone matching passes Claude the known zone list for the municipality, and it must answer one of those zones or `null`.

---

## 3. Database (SQLite, `server/schema.sql`)

| Table | Key columns | Why |
|---|---|---|
| `users` | id, name, role CHECK IN ('caregiver','coordinator','admin'), org_id NULL→organizations | Seeded demo personas; no password. Coordinators belong to a responder, facility staff to a facility |
| `organizations` | id, name, kind CHECK IN ('responder','facility'), org_type CHECK IN ('health-plan','municipality','clinic','supplier','care-home','other'), contact_email, message, status CHECK IN ('pending','approved','rejected'), created_at, reviewed_by NULL, reviewed_at NULL | Responders attend patients and need admin approval. Facilities are caregivers and are created approved. Replaces `pilot_leads` |
| `org_municipalities` | org_id→organizations, municipality (UPPERCASE), PK(both) | Where a responder can operate; scopes its call list |
| `patients` | id, caregiver_id→users, facility_id NULL→organizations, is_self INTEGER, display_name, phone, municipality (UPPERCASE), zone, consent_at NOT NULL, consent_version, confirmed_at | Registry; consent recorded at intake. One caregiver registers one or more patients; a facility's patients are shared by its staff; a partial unique index allows one `is_self` patient per user |
| `patient_needs` | patient_id→patients, kind CHECK IN ('oxygen','cpap','ventilator','dialysis','insulin','other'), battery_hours NULL | One patient can have several devices; rules read the min battery |
| `intakes` | id, caregiver_id, patient_id NULL, transcript, ai_json, status CHECK IN ('draft','confirmed','rejected') | Audit trail: AI draft vs. what the human confirmed |
| `zones` | municipality, zone, PK(both) | Catalogue for address matching, grown from readings + seed |
| `luma_readings` | id, fetched_at, source CHECK IN ('live','replay'), endpoint CHECK IN ('regions','towns'), request_body, http_status, payload JSON, luma_timestamp | Store every reading raw; matching uses `json_each(payload)` |
| `outage_events` | id, patient_id, opened_reading_id, closed_reading_id NULL, status CHECK IN ('possible','confirmed','restored','false_alarm'), opened_at, closed_at, claimed_by_org_id NULL, claimed_by NULL, claimed_at NULL | One incident per patient per outage; the first responder organization to claim it makes the call |
| `checkins` | id, event_id, sent_at, message, reply_text, reply_at, ai_parsed JSON, confirmed_by NULL, confirmed_at NULL | Original reply text kept next to the AI reading of it |
| `briefings` | id, event_id, draft_text, approved_text NULL, approved_by NULL, approved_at NULL | Coordinator approves before use |
| `call_outcomes` | id, event_id, coordinator_id, reached INTEGER, outcome, next_action, created_at | The recorded outcome closing the demo |
| `settings` | key PK, value | `mode` = live \| replay, `replay_cursor` |

**Not stored:** the priority ranking. It is computed on every request from current state, so it cannot go stale or drift from the rules.

**Visibility (enforced in the queries, not only in the UI):**
- Caregiver: patients where `caregiver_id` is the user or `facility_id` is the user's facility. A self-registered patient is a caregiver whose own record has `is_self = 1`.
- Coordinator: nothing while the organization is `pending`; events whose patient municipality is in `org_municipalities`; briefing and outcome only on events its organization claimed.
- Admin: everything, plus patients in municipalities no approved responder covers (coverage gaps).

**Priority rules (`priority.ts`, fixed, each produces a Spanish reason string):**

1. Confirmed outage + battery ≤ 4 h: tier 1, *"Sin luz confirmada; batería dura 2 h"*.
2. Unanswered check-in > 15 min + oxygen, ventilator or CPAP: tier 1, *"Sin respuesta; usa concentrador"*.
3. Confirmed outage + insulin: tier 2.
4. Possible outage, unconfirmed: tier 3.

Tie-break: lowest battery hours, then oldest event.

**Stale:** the feed counts as stale when the last successful reading is older than 2× the poll interval, or the last poll failed. Every response carries `{ lastReadingAt, stale, mode }`.

---

## 4. API endpoints (all under `/api`, zod-validated)

**Public (landing page)**
- `GET  /public/status`: latest region counts + `lastReadingAt`, `stale`, `mode`
- `POST /public/organizations {name, orgType, contactEmail, municipalities[], message}`: responder registration, stored as `pending` (replaces the pilot form)

**Demo login** (no real authentication; synthetic data only)
- `GET  /demo/personas` → seeded users with role, organization and persona type
- `POST /demo/login {userId}`
- `POST /demo/logout`
- `GET  /demo/me`

**Caregiver** (role `caregiver`: a person, facility staff, or a self-registered patient; only the patients they may see)
- `POST  /intake/extract {transcript}` → AI draft profile; nothing saved as a patient yet
- `POST  /patients {profile, isSelf, consent: true}` → saves the confirmed profile and closes the intake; `facility_id` comes from the current user, never the body
- `GET   /patients/mine`
- `PATCH /patients/:id`
- `GET   /checkins/pending`
- `POST  /checkins/:id/reply {text}`

**Coordinator** (role `coordinator`, organization approved, only events in its municipalities)
- `GET  /call-list` → ranked events with `reasons[]` and `claimedBy`
- `POST /events/:id/claim` → first organization wins; 409 if another already claimed it
- `GET  /events/:id` → patient, check-in (original + parsed), briefing, outcomes
- `POST /checkins/:id/confirm {hasPower}` → human confirms the AI parse; event becomes confirmed, restored, or false_alarm
- `POST /events/:id/briefing` → AI draft
- `POST /briefings/:id/approve {text}` (claimed events only)
- `POST /events/:id/outcome {reached, outcome, nextAction}` (claimed events only)

**Platform admin** (role `admin`)
- `GET  /patients` → full registry
- `GET  /admin/readings` → reading log with http_status
- `POST /admin/poll` → force a poll now
- `PUT  /admin/mode {mode, fromReadingId?}` → live or replay
- `GET  /admin/organizations`
- `POST /admin/organizations/:id/review {decision: 'approve' | 'reject'}`
- `GET  /admin/coverage-gaps` → patients no approved responder covers

---

## 5. The three areas

- **Landing (`/`)**, English, for judges and pilot partners:
  1. Hero with the one-line pitch.
  2. **Live LUMA numbers** from `/public/status`, with timestamp and stale label.
  3. How it works, in 6 steps.
  4. "The AI never decides who goes first."
  5. emPOWER gap: 40,000 counted, Plan Vital uncovered.
  6. "Register your organization" form for responders: type, contact, and the municipalities they can serve. Pending until an admin approves it.
- **Every area's header** has the "Ver como" persona switcher and a permanent "DEMO · sin autenticación real" label.
- **Caregiver area (`/app`)**, Spanish:
  - *"¿Para quién es este registro?"*: for me (self-registered patient) or for another person. Facility staff register for the facility, and all its staff share those patients.
  - Voice intake → review the extracted profile → consent checkbox → save.
  - My patients, with their current status.
  - Pending check-in: *"¿Tiene luz en su casa?"* with a reply box. This doubles as the demo's patient phone.
- **Admin area (`/admin`)**, Spanish:
  - Header always shows the last reading time, LIVE/REPLAY badge and stale state.
  - Call list with tier and reasons, limited to the organization's municipalities. *"Tomar caso"* claims an event; others see *"Atendido por {org}"*.
  - Event drawer: original reply, AI reading, confirm, approve briefing, record outcome.
  - System tab (admin): reading log, force poll, replay control, organizations awaiting review, coverage gaps.

---

## Sources

- [No registry of electricity-dependent patients (CPI, 2025)](https://periodismoinvestigativo.com/2025/09/puerto-rico-electricity-dependent-patients-registry-maria/)
- [Health Department refuses to create the list (CPI, 2024)](https://periodismoinvestigativo.com/2024/08/electricity-dependent-list-blackouts/)
- [HHS emPOWER Medicare data (Health Data Management)](https://healthdatamanagement.com/news/hhs-makes-medicare-data-available-to-areas-that-could-be-hit-by-irma)

## Open items before kickoff

- Plan Vital name collision: rename or turn into the partnership pitch.
- Ask at kickoff whether DME/oxygen suppliers can be pilot partners.

## Verification

- Today: re-read `Docs/architecture.md` against the spec's design rules (rules not AI, human confirmation on every AI output, stale label, store every reading, synthetic patients) and check that each one maps to a table or endpoint above.
- From Oct 8 (not now):
  - `node --test server/priority.test.ts` passes.
  - `npm run build` type-checks the RPC client against the routes.
  - Walk the 2-minute demo script end to end in replay mode.
