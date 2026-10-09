# Build plan A: Data, rules and replay

**Assignee:** _________ · **Partner plan:** `Docs/plan-ui.md` · **Design:** `Docs/vitalpower-relay.md`, `Docs/architecture.md`, `Docs/luma-api.md`

A owns everything between LUMA and the call list: polling, storage, zone matching, outage events, the fixed priority rules, replay mode, the failure tests, and which responder organization may see and claim each event. This is the part that has to be right for the demo to be honest.

## Shared contract (identical in `Docs/build-plan.md`, `Docs/plan-data.md` and `Docs/plan-ui.md`)

This is one project. There is one `package.json`, one `server/schema.sql`, one `data/vitalpower.db`, one `AppType` and one `src/api.ts`. Nobody creates a second server, database or API client.

### Who uses the system

There are two kinds of organization:
- A **responder organization** (health plan, municipality, clinic, DME/oxygen supplier) attends patients. It registers itself, declares the **municipalities** where it can operate, and sees patients only after a platform admin approves it.
- A **care facility** (for example a *hogar de envejecientes*) is a caregiver, not a responder. It registers and looks after its own residents and never sees anyone else's patients. It needs no approval.

| Persona | Role | Belongs to | Sees and does |
|---|---|---|---|
| Platform admin | `admin` | none | Everything. Approves or rejects responder organizations. Sees patients that no approved organization covers. |
| Coordinator | `coordinator` | One responder organization | The call list for its organization's municipalities, once approved. Claims an event, then briefing and outcome. |
| Caregiver, person | `caregiver` | none | The patients they registered (one or more) and their check-ins. |
| Caregiver, facility staff | `caregiver` | One care facility | All of the facility's patients, shared by every staff member. |
| Self-registered patient | `caregiver` | none | Their own record (marked `is_self`), plus anyone else they register. Answers their own check-ins. |

**Visibility is enforced in the server queries, never only in the UI:**
- Caregiver: patients where `caregiver_id` is the user, or `facility_id` is the user's facility.
- Coordinator: nothing while the organization is `pending`. Events whose patient municipality is in the organization's coverage. Briefing and outcome only on events the organization claimed.
- Admin: all.

**Overlapping coverage:** when two responder organizations cover the same municipality, both see the event. The first coordinator to press *"Tomar caso"* claims it for their organization, and the other sees *"Atendido por {org}"*, read-only. One patient gets one call.

### Demo login, no real authentication

- No passwords and no sign-up for people. `GET /api/demo/personas` lists the seeded users, and `POST /api/demo/login {userId}` sets a cookie that `requireRole()` reads.
- The shared header has a **"Ver como"** persona switcher, grouped by persona type, and a permanent **"DEMO · sin autenticación real"** label. The presenter switches roles live instead of logging in.
- Because anyone can be anyone, the app holds **synthetic data only**, always. Real authentication is a post-hackathon item.

### Hour 0: done together (45 min), then frozen

1. Write the full `server/schema.sql` from `Docs/architecture.md` §3 (13 tables; `organizations` replaces `pilot_leads`). After this, a schema change is a message to the other person plus a small commit, never a private copy.
2. Add `server/municipalities.ts`: the 78 municipality names in uppercase, as LUMA spells them. zod validates organization coverage and patient municipality against it, which also keeps unknown names (LUMA answers 500) out of the poller.
3. Add `server/seed.sql`, all synthetic:
   - 1 platform admin.
   - 2 approved responder organizations that both cover municipality X (to demo the claim); one also covers municipality Y. One coordinator each.
   - 1 pending responder organization with a coordinator (to demo approval).
   - 1 caregiver person with 2 patients, 1 care facility with 1 staff user and 2 patients, and 1 self-registered patient: **5 patients in 2 municipalities**.
   - The zone seed for X and Y. A picks X and Y from the stored readings.
4. Split `server/app.ts` into a short composer:
   `new Hono().basePath('/api').route('/', dataRoutes).route('/', appRoutes)`, keeping `export type AppType`. Hono RPC merges both route files, so `npm run build` still fails when either person changes a shape the other depends on.

### File ownership

The owner edits freely. The other person asks first.

| Area | A (Data) | B (Experience) |
|---|---|---|
| Server | `luma.ts`, `events.ts`, `priority.ts`, `municipalities.ts`, `routes-data.ts`, and their `*.test.ts` | `auth.ts` (demo login), `ai.ts`, `routes-app.ts`, and their tests |
| Frontend | `src/System.tsx` (admin System tab: readings, replay, organizations, coverage gaps) | `src/App.tsx`, `Landing.tsx`, `Caregiver.tsx`, `Admin.tsx`, `index.css` |
| Shared: change only at a sync point | `schema.sql`, `seed.sql`, `app.ts`, `package.json`, `src/api.ts`, `CLAUDE.md` | same |

### Interfaces between the two (the only coupling)

- **A gives B:**
  - `feedStatus(): { lastReadingAt, stale, mode }` for every screen header.
  - `knownZones(municipality): string[]` for AI zone matching.
  - `MUNICIPALITIES`, for the landing registration form and the intake review.
  - `setEventStatus(eventId, status)`, called by B's confirm route.
  - `claimEvent(eventId, orgId, userId): boolean`, one conditional `UPDATE`; `false` means another organization claimed it first.
  - `GET /call-list`, scoped to the caller's organization, returning `rank()` output `{ tier, reasons[] }` plus `claimedBy` per event.
- **Handoff point:** when a patient's zone appears in a reading, A opens an `outage_events` row (`possible`) **and** inserts its `checkins` row with the fixed message *"¿Tiene luz en su casa?"*. Everything after that row exists (reply, AI parse, confirm, claim, briefing, outcome) belongs to B.
- **B gives A:** `requireRole(role)` and `currentUser(c): { id, role, orgId }` from `auth.ts`. A ships `/admin/*` and `/call-list` unguarded until B merges it, then scopes `/call-list` by `orgId`.

### Git

Short branches per item, rebase on `master` at least twice a day, and run `npm test && npm run build` before every push.

### Milestones (from the spec)

- **Friday morning:** one patient end to end (reading arrives → patient flagged → call list updates), shown by switching personas.
- **Friday evening:** feature freeze.
- **Saturday:** demo rehearsal in replay mode, and the video.

## A's work, in order

The order puts the replay recording first: the earlier `towns` readings start, the more likely Saturday's replay shows a real outage captured during the build.

1. **Poll `towns` now** for the 2 demo municipalities in `server/luma.ts`. Reuse the `pollRegions` pattern (`UA` header, 20 s timeout, store every reading including failures, only a parsed payload counts as `ok`). Names must be uppercase, and an unknown name returns 500.
   - While here, confirm how LUMA spells municipalities with accents or Ñ (for example `MAYAGÜEZ`, `AÑASCO`) with a few read-only POSTs, and fix `server/municipalities.ts` to match.
2. **Zone catalogue:** grow `zones` from every stored `towns` payload (`json_each`) plus the seed. Export `knownZones(municipality)`.
3. **`server/events.ts`:**
   - Match each new reading to patients by municipality + zone.
   - Open an `outage_events` row (`possible`) and insert its check-in. Close it as `restored` when the zone leaves the feed.
   - `setEventStatus(eventId, status)` for B's confirm route.
   - `feedStatus()`: lift the stale logic out of `latestRegions` so every response shares it.
4. **`server/priority.ts` + `priority.test.ts`:** the 4 fixed rules and the tie-break from `Docs/architecture.md` §3, each producing its Spanish reason string. Pure function, no AI, no DB. This test must never break.
5. **`server/routes-data.ts`:**
   - Move `/public/status` here, with `app.test.ts`.
   - Replace `/public/leads` with `POST /public/organizations`: same `bodyLimit` + zod pattern, plus `municipalities` validated against `MUNICIPALITIES`. Stored as a `pending` responder organization. Update the leads test to match.
   - `GET /call-list`, scoped by `currentUser(c).orgId`: empty while the organization is `pending`, and only events whose patient municipality is in its coverage. Each row carries `claimedBy`.
   - `GET /admin/readings`, `POST /admin/poll`, `PUT /admin/mode`.
   - `GET /admin/organizations`, `POST /admin/organizations/:id/review {decision: 'approve' | 'reject'}`.
   - `GET /admin/coverage-gaps`: patients whose municipality no approved responder organization covers. This is the pitch's risk number: who would get no call today.
6. **`claimEvent(eventId, orgId, userId)`** in `events.ts`: one `UPDATE … WHERE id = ? AND claimed_by_org_id IS NULL`, returning whether a row changed. The database decides the race, not the UI.
7. **Replay mode:** `settings.mode` and `replay_cursor`. Replay walks stored readings in order and every response says `mode: 'replay'`.
8. **Failure tests:** bot-wall 403 HTML, 200 with HTML body, 500 on an unknown town, and a timeout are each stored as failed and produce `stale: true`.
9. **`src/System.tsx`:** reading log with `http_status`, force poll, replay control, organizations awaiting review (with their municipalities, approve or reject), and coverage gaps. B mounts it as a tab in `Admin.tsx`.
10. **Saturday:** own the replay setup for the demo (which reading id to start from, and a dry run).

## Done when

- `npm test` passes, including `priority.test.ts` and the failure tests.
- With one seeded patient, a stored reading containing their zone produces a `possible` event, a check-in row and a call-list entry with a reason.
- Switching to replay plays a recorded outage, and every screen shows `REPLAY`.
- Tests cover the organization rules:
  - A second `claimEvent` on the same event returns `false`.
  - A `pending` organization's coordinator gets an empty call list.
  - An organization covering only X never sees a patient in Y.
  - Coverage gaps list exactly the seeded patients that no approved organization covers.
