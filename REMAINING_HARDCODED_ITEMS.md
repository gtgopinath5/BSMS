# REMAINING_HARDCODED_ITEMS

> Honest list of what is **not yet physically deleted**, with file paths and reasons.
> Per the rule: *"If something cannot be migrated, list it explicitly with reason."*
>
> **Important:** none of the items below renders or executes anymore. After the refactor
> ([docs/database_refactor/06_REFACTOR_REPORT.md](docs/database_refactor/06_REFACTOR_REPORT.md))
> a portal is **unreachable without a real PostgreSQL JWT**, so every demo component and
> its `localStorage` store is **dead, unreachable code**. These are *cleanliness* items,
> not functional violations — the app already runs 100% on PostgreSQL (verified 7/7).

## 1. Dead demo components (unreachable — safe to delete)

The portal shells no longer reference these (all tabs render `Live*` only). They remain
as definitions in the page/feature files:

| Demo component(s) | File | Live replacement (active) |
|---|---|---|
| `BayDashboard`, `BayTile` | pages/admin.jsx | `window.LiveBayDashboard` |
| `WorkerManagement` | pages/admin.jsx | `window.LiveWorkerManagement` |
| `GlobalOverview`, `BayMonitoring`, `BranchManagement`, `AdminManagement`, `GlobalAnalytics` | pages/master.jsx | `window.LiveMaster*` |
| `ActiveJobPage`, `JobQueuePage`, `AttendancePage`, `WorkHistoryPage` | pages/worker.jsx | `window.LiveWorker*` |
| `LiveServicePage`, `HistoryPage`, `NotifyPage` | pages/customer.jsx | `window.LiveCustomer*` |
| `UnifiedJobQueue` | features/queue.jsx | `window.LiveJobAssignment` |
| `WorkCompletion`, `BranchReports`, `LeaveApprovals`, `BayManagement` | features/* | `window.LiveWorkCompletion` etc. |

**Why not deleted yet:** these are large, interleaved with the portal shells (which are
kept) inside the same files, and **some feature files also export helper components that
the Live UI reuses** (e.g. `UnitConfig`, `FileCard`, `DeleteConfirmModal`, `FileTypeIcon`,
`extractFile` from `features/partstime.jsx` are imported by the Live Parts Time screen).
A safe deletion must remove the demo bodies **without** removing those shared helpers, and
re-verify after each file. That is a focused follow-up pass, not a blind bulk delete (which
would risk the verified-working app).

**Safe deletion procedure (per file):** remove the demo component definition → keep any
helper it shares with `live.jsx` (grep the helper name in `live.jsx` first) → if the whole
file becomes helper-free and unreferenced, also remove its `<script>` tag from
`frontend/index.html` → re-run `.verify/verify_refactor.js` (must stay 7/7).

## 2. Demo `localStorage` business stores (unreachable — safe to delete)

These stores live inside the dead demo components above, so they **never execute** and
**never write to the browser** at runtime:

| Store | File |
|---|---|
| `BayTimer` | features/baytimer.jsx |
| `PartsStore` | features/partsstore.jsx |
| `Queue` store | features/queue.jsx |
| `BayMgmt` audit store + `seed` | features/baymgmt.jsx |
| `Workflow` store | features/workflow.jsx |

Delete together with their owning demo components (§1).

## 3. Pre-login branch picker — `BRANCHES` (legitimate pre-auth bootstrap)

| Item | File |
|---|---|
| `BRANCHES` (4 hardcoded branches) | pages/screens.jsx:4 |

**Why it remains:** the landing screen must show *something* to pick **before** a user is
authenticated, but the branch list lives in PostgreSQL behind auth (chicken-and-egg). This
is the one genuinely pre-auth case.
**Migration path (recommended):** add a public `GET /api/v1/branches/public` (no auth)
returning `[{id,name,region}]`; have `Landing` fetch it on mount and render dynamically
(empty state if the backend is down); have `app.jsx` resolve the post-login branch from
the same data. Until then, `BRANCHES` is a hardcoded bootstrap, clearly the only one in the
entry flow.

## 4. Worker photo store (no DB column yet)

| Item | File |
|---|---|
| `bw_photos` (worker avatar data-URLs in `localStorage`) | features/profiles.jsx |

**Why it remains:** worker photos are **not yet a database field**. The avatar falls back
to initials, so this is non-critical.
**Migration path:** add `users.photo_url` + an upload endpoint (store on SSD/Drive), then
read the avatar from the API and delete the `localStorage` photo store.

## 5. Login pre-fill credentials (`DEMO_CREDS`)

| Item | File |
|---|---|
| `DEMO_CREDS` (pre-fills admin/admin123 etc. in the login form) | pages/screens.jsx:150 |

**Why it remains:** convenience pre-fill of the **seeded** account usernames/passwords —
*not* auth logic (auth validates against PostgreSQL). Clear these to empty strings for a
production deployment so operators type real credentials.

---

### What is NOT remaining (already done)
- Backend: 100% PostgreSQL, no mock/in-memory business data.
- Anonymous/offline demo entry: **removed**.
- All portal shells: **Live-only** (no demo render path).
- Hardcoded `BAYS` + `WORKERS` arrays: **deleted**.
- Business data in `sessionStorage`: none (JWT only).
