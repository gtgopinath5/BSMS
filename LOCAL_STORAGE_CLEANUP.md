# LOCAL_STORAGE_CLEANUP

> Goal: business data must never live in `localStorage`/`sessionStorage`. Only
> JWT, theme, sidebar/UI state, language, and temporary form drafts are allowed.

## Demo browser stores REMOVED

Every localStorage-backed business store was deleted (with its owning demo code):

| Store | Key(s) | File (now) | Status |
|---|---|---|---|
| `PartsStore` (parts/files/config/log) | `bw_files_v3`, `bw_parts_v3`, `bw_cfg_v3`, `bw_log_v3` | was `features/partsstore.jsx` | **removed** — parts now in PostgreSQL `parts_master` via `/parts/*` |
| `BayTimer` | (in-memory + persisted) | `features/baytimer.jsx` | **file deleted** — timer state from `/worker/active` + MQTT |
| `Workflow` engine | (in-memory store) | `features/workflow.jsx` | **file deleted** — sessions in `service_sessions` |
| `QueueStore` | (in-memory store) | `features/queue.jsx` | **file deleted** — queue in `job_queue` |
| `BayAudit` log | (persisted log) | `features/baymgmt.jsx` | **file deleted** — audit in `audit_logs` |

The worker and customer **portal shells** previously read from these stores
(`useBayTimer()`, `useWorkflow()`) for their chrome (timer pill, status pill,
notification badge). They were rewired to PostgreSQL:

- `WorkerPortal` chrome → `BW_API.workerActive()` (`/worker/active`).
- `CustomerPortal` chrome → `BW_API.customerActive()` + `BW_API.customerNotifications()`.

## Final `localStorage` / `sessionStorage` inventory (post-cleanup)

Repo sweep result — every remaining use, classified:

| Use | Store | Allowed? | Why |
|---|---|---|---|
| `bw_token` (JWT) | `sessionStorage` | ✅ | auth token, per-tab |
| `bw_user` (identity mirror of JWT) | `sessionStorage` | ✅ | non-authoritative; role re-derived from JWT |
| `bw_api_base` | `localStorage` | ✅ | non-sensitive config |
| theme / sidebar / UI prefs | `localStorage` | ✅ | UI preference |
| notification "last seen" timestamp (`SEEN_KEY`, live.jsx) | `localStorage` | ✅ | UI **read-marker** (timestamp only, no business data) |
| **`bw_photos_v1`** worker avatar thumbnails (`features/profiles.jsx`) | `localStorage` | ⚠️ **not yet** | worker photos have no DB column — see below |

## The one remaining item

`bw_photos_v1` (data-URL avatar thumbnails) is the **only** business-ish value
still in the browser. It cannot be migrated without a schema change, so it is
documented with a migration plan in
[REMAINING_NON_DATABASE_ITEMS.md](REMAINING_NON_DATABASE_ITEMS.md). Avatars fall
back to initials when no photo is present, so no business decision depends on it.

Verified: `grep -rn "localStorage\|sessionStorage"` over `frontend/` returns only
the rows above (plus explanatory comments). No bays/workers/cameras/timers/jobs/
queue/sessions/recordings/notifications are stored in the browser.
