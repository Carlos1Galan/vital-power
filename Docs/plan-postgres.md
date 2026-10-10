# Plan: Postgres on Supabase, API on Vercel

**Status (2026-10-09, branch `feat/supabase`):** steps 1–3, 6 and 7 are done; 4, 5 and 8 remain. The 10-10 demo runs from `main` on SQLite plus the hybrid setup below.
**Read first:** `Docs/architecture.md` §3 (schema), `CLAUDE.md` (invariants).

### What was built
- `server/db.ts`: one async `db` with node:sqlite's `prepare().get/all/run` shape over postgres.js (`DATABASE_URL`) or PGlite. It rewrites `?`/`:name` to `$n` and quotes camelCase aliases (Postgres would fold `AS patientName` to `patientname`); `db.tx()` uses `AsyncLocalStorage`.
- `server/schema.sql`: Postgres, idempotent; `iso()` keeps timestamps as the same ISO text; `sync_ids()` moves identity sequences past explicit ids; RLS on every table (step 6).
- `server/migrate-sqlite.ts` (`npm run db:migrate-sqlite`): step 7. One transaction, ids preserved, row counts compared, refuses a target that already has readings unless `--replace`.
- Verified: all 85 tests pass on in-memory PGlite and through postgres.js against a Postgres wire server; a migration of the real `data/vitalpower.db` (182 readings) came out byte-identical, and the API replayed it, ranked it and settled a claim race on the copy.
- Step 1 was folded into step 3: converting to async and to Postgres in one pass was checked by the same tests on both drivers.

## Why

Today the whole system runs as one Node process on one laptop: the API, the LUMA poller, the WhatsApp sweep and the SQLite file. If the laptop sleeps, loses its connection or loses its disk, the call list goes dark and the recorded LUMA readings go with it. For a tool that responders use during an outage, that one machine is the main risk. This plan moves the system to free managed infrastructure and leaves the product rules untouched: priority stays in `priority.ts`, visibility stays in SQL, and claims are still decided by one `UPDATE`.

## Stage 0: hybrid (done, for the demo)

`vercel.json` serves `dist/` from Vercel and forwards `/api/*` to the laptop through a tunnel with a fixed address. No code changes.

1. Get a stable tunnel host: an ngrok free static domain, or a named Cloudflare Tunnel.
2. Replace `YOUR-TUNNEL-HOST` in `vercel.json`. Vercel rewrites can't read env vars.
3. Keep `HOST=127.0.0.1`. The tunnel connects from the laptop itself, so loopback is enough.
4. Point Twilio's webhooks straight at the tunnel host, so `PUBLIC_URL` still matches the URL Twilio signs.
5. Import the repo in Vercel (Hobby). It detects Vite and runs `npm run build` (`tsc && vite build`).

Known gap: the demo persona switcher lets anyone open the admin persona, including `/api/demo/reset`. That's acceptable for synthetic data and a demo window. Turn the tunnel off afterwards.

## Target shape

```
Browser ──> Vercel (Hobby)
              ├─ dist/ (static)
              └─ /api/* → one Node 24 function running the Hono `app`
                              │
cron-job.org ── every 3 min ──┤ POST /api/cron/poll  (Bearer CRON_SECRET)
Twilio ──────── webhooks ─────┘
                              │
                              v
              Supabase Postgres (Free), Supavisor transaction pooler :6543
```

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Driver | `postgres` (postgres.js), with `prepare: false` | Adds no dependencies of its own. The transaction pooler on :6543 doesn't support prepared statements. |
| Call shape | Keep `db.prepare(sql).get/all/run`, now async | Every call site only gains an `await`, and no query gets restructured. That's 68 `.get`, 20 `.all` and 41 `.run` calls (counted with tests). |
| Placeholders | The adapter rewrites `?` and `:name` to `$n` | The current SQL uses both styles. The rewrite must skip `::` casts and quoted strings. |
| Transactions | `sql.begin()` plus `AsyncLocalStorage`, so `db` picks the open transaction | The existing `tx(fn)` helpers in `events.ts:28` and `routes-app.ts:50` keep their shape. |
| Timestamps | Keep `TEXT` ISO-8601 with a `now_iso()` SQL function | API shapes don't change, and string comparisons such as `whatsapp.ts:66` keep working. `ponytail:` upgrade to `timestamptz` once the API returns dates on purpose. |
| Booleans | Keep `INTEGER` 0/1 | The client already does `!!p.isSelf`, so no shape changes. |
| JSON aggregates | `json_agg(...)::text` | The callers' `JSON.parse` (`events.ts:103`, `routes-app.ts:155`, `routes-data.ts:83`) stays as it is. |
| Poller | An outside cron calls a protected route every 3 min | Vercel Hobby cron is once a day at most. GitHub Actions `schedule` is 5 min at best and often runs late, which would push the feed past the 6 min stale threshold. |
| WhatsApp sweep | Run `sendCheckins()` at the end of the poll and replay-step handlers | Events open only there, so the 5 s `setInterval` (`main.ts:19`) is no longer needed. |
| Tests | PGlite (Postgres compiled to WASM, in-process) as a devDependency | `node --test` stays fast and doesn't need a server. That replaces what `:memory:` SQLite gives the tests today. |

## SQL translation inventory

| SQLite today | Postgres | Where |
|---|---|---|
| `INTEGER PRIMARY KEY` | `integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY`, then `setval` after the seed (the seed inserts explicit ids) | `schema.sql`, `seed.sql` |
| `strftime('%Y-%m-%dT%H:%M:%fZ','now')` | `now_iso()` = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` | `schema.sql` defaults, `NOW` in `routes-app.ts:23` and `whatsapp.ts:13`, `events.ts:50,64,74`, `luma.ts:62`, `routes-data.ts:89` |
| `strftime(..., 'now', '-10 minutes')` | `to_char((now() - interval '10 minutes') AT TIME ZONE 'utc', ...)` | `whatsapp.ts:66` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` | `schema.sql` settings, `events.ts:43`, `routes-data.ts:49`, `whatsapp.ts:90` |
| `.lastInsertRowid` | `RETURNING id` | `luma.ts:37`, `routes-data.ts:48`, `routes-app.ts:125,234,264,280,297,306`, `whatsapp.ts:34` |
| `.changes` | the row count (`result.count` in postgres.js) | `events.ts:65,78`, `routes-app.ts:172`, `routes-data.ts:90`, `whatsapp.ts:90` |
| `json_each(payload)` and `json_extract(z.value, '$.zone')` | `jsonb_each(payload::jsonb) m, jsonb_array_elements(m.value) z` and `z->>'zone'` | `events.ts:33,53` |
| `json_group_array(json_object(...))` | `json_agg(json_build_object(...))::text`, plus `COALESCE(..., '[]')` because `json_agg` over zero rows is NULL | `events.ts:93`, `routes-app.ts:35,144`, `routes-data.ts:81` |
| `count(*)` returns a number | returns `bigint`, which arrives as a string: write `count(*)::int` | `routes-app.ts:123` |
| `PRAGMA foreign_keys = ON` | delete it (Postgres always enforces foreign keys) | `schema.sql:2` |
| Partial unique indexes | same syntax | `one_self_patient`, `one_open_event` |
| `REAL` | `double precision` | `patient_needs.battery_hours` |

Two details are easy to miss:
- **Parameter types.** SQLite casts loosely, Postgres doesn't. Wherever a parameter is compared against `IN ('restored', 'false_alarm')` (`events.ts:64`), add an explicit `::text`.
- **Claim race.** `claimEvent` (`events.ts:74`) is still one `UPDATE … WHERE claimed_by_org_id IS NULL`. Postgres row locking keeps the guarantee: the loser updates 0 rows.

## Steps

Each step ends with `npm test && npm run build` passing.

1. **Adapter, still on SQLite.** Add `server/sql.ts` with an async `prepare().get/all/run` over `node:sqlite`, and make every call site use `await`. This step changes behavior in only one way: the code becomes async. Doing it first gives one large mechanical diff that the existing tests can prove correct before any Postgres is involved.
2. **Postgres schema and seed.** Translate `schema.sql` and `seed.sql` using the inventory above. Add `now_iso()`.
3. **Swap the engine.** Run the adapter on postgres.js (`DATABASE_URL`) and run the tests on PGlite. Add `AsyncLocalStorage` transactions. Update the `isTest` guard in `db.ts`: tests must never reach `DATABASE_URL`.
4. **Serverless entry point.** Add `api/index.ts`, which exports the Hono `app` through `hono/vercel`'s `handle`, plus a rewrite for `/api/(.*)`. `main.ts` stays as the local and dev entry point. Check that Vercel's TypeScript bundling accepts `.ts` import specifiers (`allowImportingTsExtensions`). If it doesn't, keep the code but switch the entry point to Vercel's zero-config Hono detection.
5. **Cron route.** `POST /api/cron/poll` runs `pollOnce()` and then `sendCheckins()`, and accepts only `Authorization: Bearer ${CRON_SECRET}` (compared in constant time). Register it on cron-job.org every 3 min. The stale rule (2× the poll interval) tolerates one missed call.
6. **Supabase hardening.** Enable RLS on every table with no policies. The server connects as the `postgres` role, which bypasses RLS, so this only shuts the auto-generated Data API to the anon key. Better still, turn the Data API off. Never ship the `service_role` key or the anon key to the browser: the browser talks only to `/api`.
7. **Move the recordings.** Export `luma_readings` from `data/vitalpower.db` and import it with ids preserved, then `setval`. This keeps the replay working. Today that's 168 readings, about 300 KB (as of 2026-10-09).
8. **Cut over.** Set Vercel env vars (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `TWILIO_*`, `CRON_SECRET`, `PUBLIC_URL` = the Vercel domain). Point Twilio's webhooks at Vercel, remove the tunnel rewrite from `vercel.json`, and retire the laptop.

## Free-tier fit

| Limit | Value | This app |
|---|---|---|
| Supabase database size | 500 MB, then read-only | Readings run about 1.8 KB each, 2 endpoints every 3 min: under 1 MB a day. Years of headroom. |
| Supabase inactivity pause | After about 1 week of low activity | The 3-minute poller keeps it active. If cron-job.org stops, the project pauses. Watch for Supabase's warning email. |
| Supabase pooler :6543 | No prepared statements | `prepare: false` |
| Vercel Hobby function duration | 300 s | Claude calls and the LUMA fetch are well under that. |
| Vercel Hobby use | Non-commercial only | Fine for the hackathon and pilots. A paid partner deployment needs Pro ($20/mo) and Supabase Pro ($25/mo, no pausing). |

Region: put the Supabase project in `us-east-1` and the Vercel function in `iad1`, which is closest to Puerto Rico and keeps the database round trip in the same region.

## Risks

- **The async conversion is the biggest diff.** Step 1 keeps it on SQLite so the current tests check it before anything else changes.
- **Placeholder rewriting** (`:name` vs `::cast` vs `'...:...'` inside strings). Unit-test `sql.ts` on exactly those three cases.
- **Real authentication.** Once the app lives on a public, always-on URL, the persona switcher is no longer acceptable outside a demo window. That's a separate plan: Supabase Auth would fit, and the invariant stays that `currentUser(c)` is the only source of identity.

## Out of scope

An ORM, Supabase Realtime, the Supabase JS client in the browser, and `timestamptz` columns. Each can come later, and none is needed to move off the laptop.
