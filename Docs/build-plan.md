# VitalPower Relay build plan: two assignees, one project

**Hackathon:** Caribbean AI Summit, Thu 2026-10-08 to Sat 2026-10-10 · **Design:** `Docs/vitalpower-relay.md`, `Docs/architecture.md`, `Docs/luma-api.md`

## Why this split

Two people build VitalPower Relay in 48 hours. If nobody owns specific files, each person ends up building a slice of everything (two schemas, two route files, two pollers), and the team ships two half-projects instead of one demo. This plan turns the spec's split (`Docs/vitalpower-relay.md`, "Build plan for 2 people") into file-level ownership on one repo, one package, one Postgres database (Supabase) and one typed API.

| Plan | Assignee | Owns |
|---|---|---|
| `Docs/plan-data.md` | A: Data, rules and replay | Everything between LUMA and the call list: polling, stored readings, zone catalogue, outage events, the fixed priority rules, replay mode, failure tests, organization registration and approval, coverage and claims, admin endpoints, the System tab |
| `Docs/plan-ui.md` | B: Interface, AI and the human steps | Everything a person touches: page routing, the demo persona login, the 3 AI calls, caregiver and coordinator areas, every human confirmation step, the demo and video |

## Shared contract (identical in `Docs/build-plan.md`, `Docs/plan-data.md` and `Docs/plan-ui.md`)

This is one project. There is one `package.json`, one `server/schema.sql`, one Supabase Postgres database (`DATABASE_URL`), one `AppType` and one `src/api.ts`. Nobody creates a second server, database or API client.

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

## The order of work at a glance

| When | A (Data) | B (Experience) |
|---|---|---|
| Thu, hour 0 | Shared setup together: schema, `municipalities.ts`, seed personas, `app.ts` split | Shared setup together |
| Thu | Poll `towns` for the demo municipalities (starts the replay recording), zone catalogue, `events.ts` | `App.tsx` routing + header with "Ver como", `auth.ts` demo login, `ai.ts` |
| Thu night | `priority.ts` + test, `routes-data.ts` (organization registration, scoped call list), `claimEvent` | Caregiver area: "para mí / para otra persona", voice intake → confirm → save, facility patients, check-in reply |
| Fri morning | **Milestone:** one patient end to end (reading → flagged → call list) | Same milestone |
| Fri | Replay mode, failure tests, `src/System.tsx` with organization review and coverage gaps | Coordinator area: call list, claim, event drawer, briefing, outcome; landing registration form |
| Fri evening | **Feature freeze** | **Feature freeze** |
| Sat | Replay setup and dry run | Demo script walk-through and video |

## Checking the split

- The Shared contract block is identical in all three docs.
- Every endpoint in `Docs/architecture.md` §4 and every table in §3 has exactly one owner across the two plans.
- Each design rule from the spec maps to one item in one plan:
  - Priority is fixed rules, never AI: A, `priority.ts`.
  - Every AI output passes a human confirmation step: B, intake, check-in confirm, briefing approval.
  - Stale label and last reading time on every screen: A's `feedStatus`, B's header.
  - Store every LUMA reading: A, `luma.ts`.
  - Synthetic demo patients only: hour-0 `seed.sql`. This matters more now that there is no real login.
- Each visibility rule has a test on the owner's side: A for the call-list scope and the claim race, B for the caregiver scope and writes on claimed events.
- No file appears under both owners except the "shared" row.
