# LUMA Energy PR (MiLUMA) API endpoints

This file lists every API that LUMA's MiLUMA web client (`https://miluma.lumapr.com`) calls, what each one does, and whether it works without a login. LUMA does not document these APIs and can change them at any time.

**How this list was made (2026-10-08, read-only):** we downloaded the production bundle `assets/index-CN5xJy24.js` (1.2 MB). From it we pulled the 11 base URLs (`VITE_REACT_APP_*_API_URI`) and every `Ae(base, path)` call, 55 paths in total. We then sent one GET request without a login to each endpoint that might be public. We did **not** call any POST endpoint with side effects, such as reporting an outage, making a payment, or opening a service call.

**Why it matters (risk):** VitalPower already uses every public outage source. Anything more detailed needs a LUMA customer login, which this app must not use for patient data.

**Host:** `https://api.miluma.lumapr.com`. LUMA's Incapsula bot wall answers 403 to any request without a browser `User-Agent`. Endpoints that need a login answer 403 (a Spring JSON error body) or 401 when called without one.

## 1. Public endpoints (no login, HTTP 200)

| Method | Path | Purpose | Use in VitalPower |
|---|---|---|---|
| GET | `/miluma-outage-api/outage/regionsWithoutService` | The 7 regions, each with total clients, clients without service, planned outage, load shed and percentages, plus LUMA's timestamp | **In use** (`pollRegions` in `server/luma.ts`, every 3 min) |
| POST | `/miluma-outage-api/outage/municipality/towns` | Body `["ARECIBO"]` (must be uppercase). Returns the affected barrios and sectors by name only, with no counts | **Planned:** zone matching |
| GET | `/miluma-app-config-api/v2/configs` | 62 feature flags and banners, including `MiLumaOutage.OutageMap.Enable`, `MiLumaOutage.LoadShed.Enable`, maintenance and downtime windows, and status and warning banners | Optional: show "LUMA in maintenance" next to the stale label |
| GET | `/miluma-app-config-api/getGeneralPurposeBanners` | LUMA's public notice banners (empty as of 2026-10-08) | Optional: show LUMA notices as context |

LUMA's own client refreshes every 180000 ms (3 min, set by `VITE_REACT_APP_CONFIG_REQUEST_INTERVAL_MS`). That matches our `POLL_MS`, so polling more often would not return fresher data.

## 2. Endpoints that need a customer login (do not use)

These endpoints need a MiLUMA customer bearer token and return that customer's data. They are listed here for completeness only.

### `miluma-report-outage-api`: outages at one customer's address (403 without a login)

| Method | Path | Purpose |
|---|---|---|
| GET | `v3/outage/premises?premiseIds=` | Outage status of the customer's addresses (premises) |
| GET | `v3/outage/transformer/{spId}` | Outage status of the transformer that serves a service point |
| GET | `v3/outage/sectors/{town}` | Outage status of each sector in a town |
| GET | `v3/outage/planned?spId=` or `?accId=` | Planned outages for an address or an account |
| GET | `v3/outage/field-activities?accId=` | Open crew or field work on the account |
| POST | `v3/outage` | **Reports** an outage (side effect) |

These endpoints hold the household-level data that an official data agreement with LUMA would unlock (see `Docs/vitalpower-relay.md`).

### `miluma-servicecall-api`: service requests (403 without a login)

- GET `location/towns` and GET `location/sectors/{town}`: the full list of towns and sectors. This is the zone catalogue VitalPower lacks, and it needs a login.
- GET `serviceCall/jobTypes`, GET `serviceCall/{id}` and POST `serviceCall`: create and track service calls.

### `miluma-api`: login, users and accounts (401 without a login)

- **Login:** POST `api/v2/auth`, GET `api/v2/auth/renew-token`, POST `api/v2/auth/send-mfa-code/`, `api/v2/auth/mfa-verify/{pref}/{code}`
- **Registration:** POST `api/v2/users/register`, `register/usernameAvailable`, POST `register/sendTwilioCode`, `register/verifyTwilioCode`
- **Account recovery:** POST `api/user/forgotPassword`, POST `api/user/forgotUsername`, POST `api/v2/users/resetPassword`
- **Profile:** POST `api/v3/users/update`, `update/unverified`, `update/sendUnlock`, `update/verifyUnlock`, DELETE `api/v3/users/delete`
- **Accounts:** POST `api/v3/users/addAccount`, `api/accounts/addAccountLookup`, POST `api/v2/ccbAccounts` (sets the account nickname), `api/v2/ccbAccounts/registrationLookup`, POST `api/v3/ccbAccounts/update`, `update/unverified`, POST `verify/sendCode`
- **Campaigns:** GET `v3/campaigns/enabled`, GET `api/v3/users/dismiss-campaign`

### Other services

| Service | Endpoints | Purpose |
|---|---|---|
| `miluma-bill-api` | GET `api/bill/history`, GET `api/bill/{acct}/invoice/{id}` | Bill history and invoice PDF |
| `miluma-bill-objection-api` | POST `api/v1/billObjections`, GET `api/v1/billObjections/calculate?accId=` | File a bill dispute and calculate the disputed amount |
| `miluma-payment-api` | POST `v1/makePayment`, GET `v1/history?accId=` | Make a payment and see payment history |
| `miluma-certification-api` | GET `certification/documentTypes`, POST `certification`, GET `certification/pdf?webCode&accId&locale`, GET `certification/validation/{a}/{b}` | Balance and service certificates |
| `miluma-notification-api` | `v1/messages`, POST `v1/messages/read`, `v1/services`, `v1/sms-preferences/{acct}` | Message inbox and SMS alert settings |
| `miluma-email-api` | POST `form` | Contact form |

## 3. Checking the list again

- `curl -s -A "<browser UA>" https://api.miluma.lumapr.com/miluma-app-config-api/v2/configs` should return 200 with JSON.
- The same request to `/miluma-report-outage-api/v3/outage/sectors/ARECIBO` should return 403, which confirms that endpoint needs a login.
- When LUMA ships a new bundle, run `grep -o 'miluma-[a-z-]*-api' assets/index-*.js | sort -u` on it and compare the result with this list.

The Google Maps key, the Datadog and App Insights IDs, and the usernames found in the bundle are left out on purpose: we don't need them, and copying them here would spread them further.
