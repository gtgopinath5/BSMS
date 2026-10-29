# 01 — HARDCODED DATA AUDIT

> Full audit performed **before any change** (your rule #1). Every item below is
> grounded in a real `file:line`. The headline: the **backend is already 100%
> PostgreSQL-driven**, and the **frontend already shows only PostgreSQL data when
> logged in** — the hardcoded data is a *dormant offline/anonymous-demo fallback*.

## How the dual-mode frontend works (the thing to understand first)

- `BW_API.isLive()` = `!!token()` — [frontend/js/api.js:32](../../frontend/js/api.js#L32).
- Every portal tab renders `live ? <LiveX/> : <DemoX/>` where `live = isLive()`.
- A token only exists after a **real backend login**. So **logged-in = live = PostgreSQL**.
- The `<DemoX/>` branch (hardcoded arrays + localStorage) renders **only** in the
  anonymous path: a `#admin`/`#worker`/… deep-link with **no login**
  ([frontend/app.jsx:35-45](../../frontend/app.jsx#L35-L45)).

**Implication:** removing the demo layer cannot break the logged-in app, because the
logged-in app never touches it.

## A. Backend — hardcoded / mock / in-memory business data

| Checked | Result |
|---|---|
| Mock/fake API responses | **none** — every route queries PostgreSQL (`db.scalars(...).all()` / `db.get`) |
| In-memory business state | **none** — `recording_service._active` (ffmpeg `Popen` handles), `camera._processes` (subprocess handles), `timer._mem` (Redis-**down** fallback only), `mqtt._bay_map` (cache *derived from* the DB), `scheduler._last_run` (observability timestamps). All operational, not business data. |
| Hardcoded lists returned by routes | **none** — the 3 `return ok([{…}])` sites (`customer.py:109`, `master.py:153`, `parts.py:432`) are list-comprehensions over DB rows |
| Seed data | `app/seed.py` writes **real bootstrap rows to PostgreSQL** (1 master, 1 admin, crew, branches, bays). Idempotent (`return` if any user exists). The `admin123`/`master123`/`worker123` are bootstrap **defaults stored hashed in the DB** — auth validates against the DB, so it *is* database-driven (change the passwords in production). |

→ **No backend changes required for the single-source-of-truth goal.**

## B. Frontend — hardcoded business-data arrays (render only in demo mode)

| Item | File:line | Contains | Disposition |
|---|---|---|---|
| `BAYS` | [admin.jsx:21](../../frontend/pages/admin.jsx#L21) | 8 fake bays (Karthik R., S. Murugan…, fake vehicles/plates/job cards) | **REMOVE** — Live source: `GET /api/v1/bays/operations` |
| `WORKERS` | [admin.jsx:508](../../frontend/pages/admin.jsx#L508) | 7 fake workers + fake stats | **REMOVE** — Live source: `GET /api/v1/workers` |
| `SEED` (queue) | [features/queue.jsx:16](../../frontend/features/queue.jsx#L16) | demo job queue | **REMOVE** — Live: `GET /api/v1/queue` |
| `seed` (bay audit) | [features/baymgmt.jsx:13](../../frontend/features/baymgmt.jsx#L13) | demo audit rows | **REMOVE** — Live: `GET /api/v1/platform/activity` |
| `PARTS_SEED` | features/partsstore.jsx:31 | demo parts | **REMOVE** — Live: `GET /api/v1/parts` |
| Hardcoded identities | [app.jsx:41-43](../../frontend/app.jsx#L41-L43), [app.jsx:95-96](../../frontend/app.jsx#L95-L96) | `EMP-802/Karthik Rajan`, `ADMIN-014/A. Krishnan`, etc. | **REMOVE** — identity comes from the JWT/login |
| `BRANCHES` | [screens.jsx:4](../../frontend/pages/screens.jsx#L4) | branch picker list (pre-login) | **MIGRATE** via a public `GET /api/v1/branches/public` (the only genuinely pre-auth case) |
| `ROLES` | [screens.jsx:11](../../frontend/pages/screens.jsx#L11) | which portals exist (master/admin/worker/customer) | **KEEP** — app structure, not business data |

## C. Frontend — localStorage business stores (demo only)

| Store | File | Holds | Disposition |
|---|---|---|---|
| BayTimer | features/baytimer.jsx | demo countdown state | REMOVE (Live timer = Redis backend + `/bay-dashboard`) |
| PartsStore | features/partsstore.jsx | demo parts | REMOVE (Live = `/api/v1/parts`) |
| Queue store | features/queue.jsx | demo queue | REMOVE (Live = `/api/v1/queue`) |
| BayMgmt audit | features/baymgmt.jsx | demo audit | REMOVE (Live = `/api/v1/platform/activity`) |
| Workflow | features/workflow.jsx | demo job lifecycle | REMOVE (Live = workflow engine in PostgreSQL) |
| Photo store | features/profiles.jsx | worker photo thumbnails (data-URLs) | REVIEW — worker photos aren't yet a DB feature; see [REMAINING_HARDCODED_ITEMS](../../REMAINING_HARDCODED_ITEMS.md) |
| `SEEN_KEY` | live.jsx:4830 | "notifications last seen" timestamp | KEEP — a UI read-marker (preference), not business data |

## D. Allowed browser storage (kept)

| Key | Where | Why allowed |
|---|---|---|
| `bw_token` (JWT) | sessionStorage | auth token (per-tab isolation) |
| `bw_user` (id/name/role/branch) | sessionStorage | session identity — mirrors JWT claims; role checks actually decode the JWT |
| `bw_api_base` | localStorage | backend URL config |
| theme / notification seen-marker | localStorage | UI preferences |

## Refactor strategy (executed in [06_REFACTOR_REPORT](06_REFACTOR_REPORT.md))

1. **Kill anonymous-demo mode** in `app.jsx` → a portal is unreachable without a real
   JWT → every `live ?` ternary always renders the PostgreSQL branch.
2. Add public `GET /api/v1/branches/public` for the pre-login branch picker.
3. Delete the now-unreachable demo data arrays, demo `localStorage` stores, and
   hardcoded identities.
4. Verify: login + every portal loads from PostgreSQL; a no-login deep-link shows the
   login flow (no demo); refresh reloads from PostgreSQL.
