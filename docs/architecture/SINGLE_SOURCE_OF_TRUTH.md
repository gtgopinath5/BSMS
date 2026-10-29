# SINGLE SOURCE OF TRUTH — Architectural Contract

> **The rule:** *every runtime business value originates from PostgreSQL.*
> The frontend is a UI layer; it fetches on mount, re-fetches on refresh, and
> renders empty states when the API returns nothing. It never invents business
> data. This document is the contract — changes that reintroduce hardcoded
> business state or browser-stored business data are violations of it.

## Runtime data ownership

| Entity | Owner | Read path (frontend → API → table) |
|---|---|---|
| Users / auth / roles | **PostgreSQL** `users` | `/auth/login`, `/workers`, `/master/admins` |
| Workers | **PostgreSQL** `users` (role=worker) | `/workers`, `/worker/*` |
| Bays | **PostgreSQL** `bays` | `/bays`, `/bays/operations` |
| Worker ↔ bay assignment | **PostgreSQL** `bays.primary_worker_id` + `bay_temp_assignments` | resolved by `resolve_bay_worker()` |
| Cameras | **PostgreSQL** `bay_cameras` | `/cameras` |
| Timers / ESP32 | **PostgreSQL** `timer_devices` | `/timers` |
| Jobs | **PostgreSQL** `job_cards` | `/jobs`, `/queue` |
| Queue | **PostgreSQL** `job_queue` | `/queue` |
| Service sessions | **PostgreSQL** `service_sessions` | `/bay-dashboard`, `/worker/active`, `/customer/active-service` |
| Recordings | **PostgreSQL** `recording_sessions` | `/storage`, `/recordings/{id}` |
| Notifications | **PostgreSQL** `notifications` | `/customer/notifications` |
| Audit / activity | **PostgreSQL** `audit_logs` | `/platform/activity` |
| Branches | **PostgreSQL** `branches` | `/branches` (public, pre-login) |
| Parts | **PostgreSQL** `parts_master`, `imported_files`, `unit_conversion_settings` | `/parts/*` |
| Worker performance / KPIs | **computed** from the tables above | `/reports/*`, `/platform/system-health` |

## The ONLY values allowed in browser storage

| Value | Store | Key |
|---|---|---|
| JWT (auth token) | `sessionStorage` (per-tab) | `bw_token` |
| Authenticated user identity (mirror of JWT) | `sessionStorage` | `bw_user` |
| API base URL (config, non-sensitive) | `localStorage` | `bw_api_base` |
| Theme | `localStorage` | (theme key) |
| Sidebar / UI preference state | `localStorage` | (ui keys) |
| Notification "last seen" read-marker (timestamp only) | `localStorage` | `SEEN_KEY` |

**Anything not in this table must not be stored in `localStorage`/`sessionStorage`.**
No bays, workers, cameras, timers, jobs, queue, sessions, recordings,
notifications, or audit rows are ever cached in the browser.

## Enforcement notes

- There is **no demo/offline/anonymous path**. Every portal requires a real
  PostgreSQL-issued JWT (`isLive() = !!token()`); with no token the app shows
  only the landing/login screen.
- Login validates against `users` (hashed). There are **no seeded/pre-filled
  credentials** in the UI and **no `admin123` fallback** in code.
- Portal shells render `window.Live*` components only — these fetch from the API.
  There are no `live ? <Live/> : <Demo/>` branches and no `const BAYS/WORKERS/
  CAMERAS/TIMERS` arrays anywhere in the frontend.
- Worker-history immutability (START freezes the worker on a job forever) is part
  of this model and lives in `service_sessions`.

## How to keep the contract

1. New screen needs data → add a backend endpoint + `BW_API` method; fetch on
   mount. Never embed the data in the component.
2. New per-user UI preference → `localStorage`, and add a row to the table above.
3. Any new business entity → it gets a table; the frontend only ever reads/writes
   it through the API.

Verify at any time with `bash .verify/startup_check.sh` (must end
`✅ Stack is up and PostgreSQL-backed.`).
