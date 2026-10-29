# FINAL_HARDCODE_AUDIT

> Repo-wide sweep for hardcoded/demo/mock/seed data after the purification pass.
> Patterns searched across `frontend/` (excluding `.verify/` and `node_modules`):
> `localStorage`, `sessionStorage`, `mock`, `fake`, `demo`, `seed`, `fallback`,
> `hardcoded`, `const BAYS`, `const WORKERS`, `const CAMERAS`, `const TIMERS`.

## Result summary

| Pattern | Matches (business data) | Verdict |
|---|---|---|
| `const BAYS` / `const WORKERS` / `const CAMERAS` / `const TIMERS` | **0** | ✅ none anywhere |
| `DEMO_CREDS` | **0** | ✅ removed |
| `mock` / `fake` | **0** | ✅ none |
| `PartsStore` / `QueueStore` / `BayAudit` / `useWorkflow` / `useBayTimer` | **0** (1 comment only) | ✅ demo stores deleted |
| `sessionStorage` | JWT + user mirror only | ✅ allowed |
| `localStorage` | api_base, theme, read-marker, + `bw_photos` | ✅ allowed, except `bw_photos` ⚠️ (documented) |

## Backend

Already 100% PostgreSQL (prior engagements). No mock/in-memory business data; the
only non-DB state is process handles (FFmpeg/subprocess), a Redis-down fallback,
a DB-derived cache, and observability timestamps. **No backend changes were
needed for hardcode removal.** A new public read endpoint was *added*:
`GET /api/v1/branches` (no auth) so the pre-login facility picker reads from
PostgreSQL.

## Frontend — every hardcoded business source, and its disposition

| Source (before) | File | Disposition |
|---|---|---|
| `BRANCHES` (4 hardcoded branches + fake counts) | `pages/screens.jsx` | → **`GET /api/v1/branches`** (PostgreSQL `branches`, live bay/crew/today counts) |
| `BAYS` / `WORKERS` arrays | `pages/admin.jsx` | **deleted** (were already `[]`; now gone) |
| Demo portal components (all four portals) | `pages/*.jsx` | **deleted** — shells render `window.Live*` only |
| `PartsStore`, `BayTimer`, `Workflow`, `QueueStore`, `BayAudit` (localStorage) | `features/*.jsx` | **deleted** (5 files) |
| Hardcoded worker identity (`Karthik R.`, `EMP-802`) in navbar | `pages/worker.jsx` | → **`user.name` / `user.id`** (JWT/PostgreSQL) |
| Hardcoded worker profile (name, stats, specialties, contact) | `pages/worker.jsx` | identity + jobs/score → **PostgreSQL** (`/reports/worker-performance`); non-schema fields → `—` (documented) |
| Fake "New job assigned · JOB-1055" toast on worker login | `pages/worker.jsx` | **removed** |
| Customer status pill / session / notifications (from `useWorkflow`) | `pages/customer.jsx` | → **`/customer/active-service` + `/customer/notifications`** |
| `DEMO_CREDS` login pre-fill | `pages/screens.jsx` | **removed** — login form starts empty |
| Demo `WorkCompletion`/`ROSTER`/`COMPLETIONS`, demo PDF, `ImportModal` etc. | `features/completion.jsx`, `features/partstime.jsx` | **deleted** (shared recording/parts helpers kept) |

## Remaining (full detail + migration plans)

Only **worker avatar photos** (`bw_photos` localStorage) remain as business-ish
data, plus a few UI placeholders (profile contact fields, shift window). All are
listed with file/line/reason/plan in
[REMAINING_NON_DATABASE_ITEMS.md](REMAINING_NON_DATABASE_ITEMS.md).

**Conclusion:** no demo arrays, demo stores, mock providers, or seeded runtime
values remain. Every business entity at runtime originates from PostgreSQL.
