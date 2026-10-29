# SINGLE_SOURCE_OF_TRUTH

> Every business entity has exactly **one owner: PostgreSQL** (`bsms` @ PG17:5433).
> Nothing business-critical is duplicated in the browser, in memory, or hardcoded.
> Detailed ownership/relationships: [workflow-details/OWNERSHIP_MAP.md](workflow-details/OWNERSHIP_MAP.md).

## Owner of each entity

| Entity | Single owner (table) | Read path | Written by |
|---|---|---|---|
| Users / roles / auth | `users` | `/auth/login`, `/workers`, `/master/admins` | seed + admin/master endpoints |
| Workers | `users` (role=worker) | `/workers` | `/workers`, `/master/admins` |
| Bays | `bays` | `/bays/operations` | `/bays*` |
| Worker↔bay assignment | `bays.primary_worker_id` + `bay_temp_assignments` | resolved by `resolve_bay_worker()` | Bay Management only |
| Cameras | `bay_cameras` | `/cameras` | `/cameras*` |
| Timers / ESP32 | `timer_devices` | `/timers` | `/timers*` |
| Jobs | `job_cards` | `/queue`, `/jobs` | `/jobs*` |
| Queue | `job_queue` | `/queue` | workflow engine + `/queue*` |
| Service sessions | `service_sessions` | `/bay-dashboard`, `/worker/active` | workflow engine |
| Recordings | `recording_sessions` | `/storage`, `/recordings/{id}` | recording service + scheduler |
| Notifications | `notifications` | `/customer/notifications` | workflow engine |
| Audit / activity | `audit_logs` | `/platform/activity` | `log_action()` |
| Reports / KPIs | **computed** from the tables above | `/reports/*`, `/platform/system-health` | (read-only SQL aggregates) |
| Storage records | `recording_sessions` | `/storage` | scheduler |
| Branches | `branches` | `/master/branches` | `/master/branches` |

## No duplicate business state — enforced

| Was it duplicated? | Status |
|---|---|
| Hardcoded `BAYS` / `WORKERS` arrays (frontend) | **deleted** |
| Demo `localStorage` stores (BayTimer/Parts/Queue/BayMgmt/Workflow) | **unreachable** (demo never renders) → no runtime browser writes; physical delete tracked in [REMAINING_HARDCODED_ITEMS](REMAINING_HARDCODED_ITEMS.md) |
| Anonymous-demo identities (frontend) | **deleted** |
| Backend in-memory business state | **none** — only ffmpeg/subprocess handles, a Redis-down fallback, a DB-derived cache |
| Dashboard KPIs | **computed from SQL**, never from frontend arrays |

## The rule going forward

- Frontend = **UI layer only**. It fetches on mount, re-fetches on refresh, and renders
  **empty states** when the API returns nothing — it never invents business data.
- Browser storage is limited to: JWT (`bw_token`), session identity (`bw_user`),
  `bw_api_base`, theme, and UI read-markers. **Never** business data.
- Backend = the only writer of business state, always to PostgreSQL.

Worker-history immutability (START freezes the worker on a job forever) is part of this
model and is proven in [workflow-details/FINAL_PRODUCTION_CHECKLIST.md](workflow-details/FINAL_PRODUCTION_CHECKLIST.md).
