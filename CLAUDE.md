# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

VitalPower Relay is a 48-hour hackathon build (Caribbean AI Summit, 2026-10-08 to 10-10, team of 2). It keeps a consent-based registry of electricity-dependent patients in Puerto Rico. It watches LUMA's public outage feed and turns an outage into a ranked call list for responder organizations.

As of the initial commit the repo holds **only design docs in `Docs/`**: no `package.json`, no `server/`, no `src/`. Devpost rules forbade writing code before Oct 8. Some docs describe code as if it already exists (for example `pollRegions` in `server/luma.ts`, `/public/leads`). Check the actual tree before you rely on any file.

Read in this order: `Docs/vitalpower-relay.md` (product spec) → `Docs/architecture.md` (schema, endpoints, areas) → `Docs/build-plan.md` (shared contract, file ownership) → `Docs/plan-data.md` / `Docs/plan-ui.md` (per-person task lists) → `Docs/luma-api.md` (LUMA endpoint inventory).

## Planned stack and commands

One package, two processes in dev:
- Vite + React 19 + TS frontend in `src/`.
- Hono API in `server/`. Node 24 runs the `.ts` files directly through type stripping, so use erasable syntax only (no enums, no namespaces, no parameter properties).
- Postgres: Supabase in production through `postgres` (postgres.js) at `DATABASE_URL`; without it, PGlite (in-process Postgres) under `data/pglite`; tests always use an in-memory PGlite. No ORM: plain SQL in `server/schema.sql` + `server/seed.sql`. `server/db.ts` keeps node:sqlite's `prepare(sql).get/all/run` shape (async) and `?`/`:name` placeholders; a camelCase alias (`AS patientName`) is quoted for you. `npm run db:migrate-sqlite` copies an old `data/vitalpower.db` across once.

Planned commands:
- `npm run dev`: Vite. It proxies `/api` to `:3000` through `server.proxy`.
- `npm run api`: `node --watch server/main.ts`.
- `npm run build`: also type-checks the Hono RPC client against every route. A changed route shape must break this build.
- `npm test`: `node --test`. Run a single file with `node --test server/priority.test.ts`.
- Before every push: `npm test && npm run build`.

The only dependencies are `hono`, `@hono/node-server`, `zod`, `@hono/zod-validator`, `@anthropic-ai/sdk` and `postgres` (dev: `@electric-sql/pglite`). React Router, an ORM, real auth and an SMS provider were left out on purpose; see `Docs/architecture.md` §2.

## Architecture essentials

- **Typed API client:** `server/app.ts` composes `new Hono().basePath('/api').route('/', dataRoutes).route('/', appRoutes)` and exports `type AppType`. `src/api.ts` is `hc<AppType>('/')` and imports only the **type**. In prod, Hono serves `dist/` on the same origin, so there is no CORS.
- **Routing:** `src/App.tsx` is a pathname switch: `/` Landing (English, for judges and partners), `/app` Caregiver (Spanish), `/admin` Coordinator/Admin (Spanish).
- **Data flow:** `luma.ts` polls `regionsWithoutService` and `municipality/towns` every 3 min (LUMA's own refresh rate) and stores **every** reading raw in `luma_readings`, failures included. Then `events.ts` matches zones to patients:
  - it opens an `outage_events` row (`possible`) and inserts a `checkins` row with "¿Tiene luz en su casa?";
  - the caregiver replies, the AI parses the reply and a coordinator confirms;
  - `priority.ts` ranks the events, and the call list shows `{ tier, reasons[] }`;
  - a coordinator claims the event, approves the briefing and records the outcome.
- **The priority ranking is never stored.** It is computed per request from current state.

## Invariants (do not break)

- **Priority comes from fixed rules in `priority.ts`, never from AI.** It is a pure function with Spanish reason strings. `priority.test.ts` must always pass.
- **Every AI output passes a human step before use:** the caregiver confirms the extracted profile, the coordinator sees the original reply next to the parse, and the coordinator approves the briefing. AI zone matching must return one of `knownZones(municipality)` or `null`.
- **Visibility is enforced in the SQL queries, not the UI:**
  - Caregivers see their own patients plus their facility's patients.
  - A coordinator in a `pending` org sees nothing, otherwise only its orgs' municipalities. Briefing and outcome work only on events its org claimed.
  - Admin sees everything.
- **Claims:** `claimEvent` is one `UPDATE … WHERE claimed_by_org_id IS NULL`, so the database decides the race (409 or `false` for the loser).
- **`facility_id` always comes from `currentUser(c)`, never from the request body.**
- **Every response carries `{ lastReadingAt, stale, mode }`.** The feed is stale when the last successful reading is older than 2× the poll interval or the last poll failed. Replay mode labels every screen `REPLAY`.
- **Synthetic data only.** Auth is a demo persona switcher: the cookie holds only the user id, there are no passwords, and every header shows "DEMO · sin autenticación real".
- **Validate with zod at every trust boundary.** Validate municipalities against `server/municipalities.ts`: uppercase, spelled as LUMA spells them. LUMA returns 500 on an unknown name and an empty list on mixed case.

## LUMA API gotchas

- Requests need a browser `User-Agent`. Without one, the Incapsula bot wall answers 403 with HTML.
- A reading counts as `ok` only when its payload parsed. A 200 with an HTML body is a failure.
- Use only the public endpoints listed in `Docs/luma-api.md` §1. Never use endpoints that need a customer login. Never call POSTs that have side effects.
- Zone data is names only, with no counts. Region-level planned and load-shed counts are context, not a priority input.

## Team ownership

Two assignees own the files: A (Data) and B (UI/AI). The full table is in `Docs/build-plan.md` "File ownership". Change shared files only at a sync point: `schema.sql`, `seed.sql`, `app.ts`, `package.json`, `src/api.ts` and this `CLAUDE.md`. Never create a second server, database or API client. The docs say to rebase on `master`, but this repo's default branch is `main`.
