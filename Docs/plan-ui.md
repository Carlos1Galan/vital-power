# Build plan B: Interface, AI and the human steps

**Assignee:** _________ · **Partner plan:** `Docs/plan-data.md` · **Design:** `Docs/vitalpower-relay.md`, `Docs/architecture.md`

B owns everything a person touches: the three areas, the demo persona login, the AI calls, and every human confirmation step that the AI output passes through. This is the part judges see.

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

## B's work, in order

1. **`src/App.tsx` pathname switch** (`/` → Landing, `/app` → Caregiver, `/admin` → Admin) and a shared header using `feedStatus` (last reading time, LIVE/REPLAY badge, stale label), plus the **"Ver como"** persona switcher and the **"DEMO · sin autenticación real"** label. Every screen shows it.
2. **`server/auth.ts` (demo login, no passwords):**
   - `GET /demo/personas` (seeded users with role, organization and persona type), `POST /demo/login {userId}`, `POST /demo/logout`, `GET /demo/me`.
   - The cookie holds only the user id (`hono/cookie`). Every request loads the user from the database, so a deleted or changed persona takes effect immediately.
   - `requireRole(role)` and `currentUser(c): { id, role, orgId }` for A.
3. **`server/ai.ts`:** add `@anthropic-ai/sdk` (check the current model and SDK usage before writing; the design names `claude-sonnet-5-5`). Three calls, each with output validated by zod:
   - Extract the patient profile from the transcript. The zone must be one of `knownZones()` or `null`.
   - Parse the check-in reply.
   - Draft the Spanish briefing and call script.
4. **Caregiver area (`/app`, Spanish):**
   - Intake starts with *"¿Para quién es este registro?"*: **"Para mí"** (sets `is_self`; hidden once the user already has a self record) or **"Para otra persona"**.
   - Web Speech (`es-PR`) with a textarea fallback → `POST /intake/extract` → review → consent checkbox → `POST /patients`.
   - Facility staff register patients for their facility. `facility_id` always comes from `currentUser(c)`, never from the request body.
   - My patients: every patient the user may see (their own registrations, or all of the facility's), with current status.
   - Pending check-ins for all of those patients, each with a reply box. This is the demo's "patient phone".
5. **Coordinator area (`/admin`, Spanish):**
   - A coordinator of a `pending` organization sees only *"Su organización está pendiente de aprobación"*.
   - Call list with tier and reasons, straight from `GET /call-list`.
   - **"Tomar caso"** calls `POST /events/:id/claim` (`claimEvent`). If another organization won, the row shows *"Atendido por {org}"*, read-only.
   - Event drawer: original reply next to the AI reading, confirm (calls `setEventStatus`). Approving the briefing and recording the outcome are enabled only on events the organization claimed, and the server checks it again.
   - Routes in `server/routes-app.ts` per `Docs/architecture.md` §4 (intake, patients, check-ins, claim, events, briefings, outcomes).
   - Mount A's `src/System.tsx` as the System tab.
6. **Landing:** turn the "Request a pilot" form into **"Register your organization"** for responders: name, type, contact email, a checklist of municipalities from `MUNICIPALITIES`, and a message. It posts to `POST /public/organizations`, and the success message says the registration awaits review.
7. **Saturday:** walk the 2-minute demo script end to end in replay mode, switching personas with "Ver como" (caregiver → coordinator) instead of logging in, then record the video. If time allows, add a 10-second beat where the admin approves the pending organization.

## Done when

- `npm run build` passes (the typed client matches every route from both route files).
- No AI output is saved or used before a person confirms it: profile (caregiver), reply reading (coordinator sees the original text), briefing (coordinator approves).
- The 2-minute demo script runs start to finish without touching the database by hand.
- Every persona in the switcher can do its part: caregiver person, facility staff, self-registered patient, coordinator of each organization, admin.
- Tests cover the visibility rules: a caregiver asking for another caregiver's patient gets 404, facility staff see all facility patients, and a coordinator writing a briefing on an event another organization claimed gets 403.
