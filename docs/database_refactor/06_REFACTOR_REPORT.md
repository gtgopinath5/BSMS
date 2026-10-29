# 06 — REFACTOR REPORT

> What changed to make the system database-driven, and how it was verified. The
> guiding finding (see [01_HARDCODED_AUDIT](01_HARDCODED_AUDIT.md)): the **backend was
> already 100% PostgreSQL-driven** and the **logged-in frontend already used only
> PostgreSQL data** — the hardcoded data was a dormant *anonymous-demo* fallback. The
> refactor removes that fallback so PostgreSQL is the **only** path.

## Files changed

| File | Change |
|---|---|
| [frontend/app.jsx](../../frontend/app.jsx) | Removed the **anonymous-demo entry** (a `#admin`/`#worker` deep-link no longer opens a portal with a hardcoded identity) and the **offline-login fallback** in `finishLogin`. A portal now requires a real backend JWT. |
| [frontend/pages/screens.jsx](../../frontend/pages/screens.jsx) | `Login.submit` now calls the backend **only** — no offline/demo fallback; failure shows an error. |
| [frontend/pages/admin.jsx](../../frontend/pages/admin.jsx) | Shell renders **Live (PostgreSQL) components only** (removed all `live ? <Live/> : <Demo/>` branches). Deleted the hardcoded `BAYS` (8 fake bays) and `WORKERS` (7 fake workers) arrays. |
| [frontend/pages/master.jsx](../../frontend/pages/master.jsx) | Shell → Live-only (11 tabs). |
| [frontend/pages/worker.jsx](../../frontend/pages/worker.jsx) | Shell → Live-only. |
| [frontend/pages/customer.jsx](../../frontend/pages/customer.jsx) | Shell → Live-only. |

## What this achieves

- **A portal is unreachable without a PostgreSQL-validated JWT.** Therefore every tab
  renders its `Live*` component, which fetches from the API → PostgreSQL.
- **No hardcoded business data can render**, and the demo `localStorage` stores (which
  lived inside demo components) **never execute** → no business data is written to the
  browser at runtime.
- The frontend is a **UI layer only**; PostgreSQL is the single source of truth.

## Backend

**No changes required.** The audit confirmed every route already queries PostgreSQL;
in-memory state is only operational (ffmpeg/subprocess handles, a Redis-down fallback,
a DB-derived cache, observability timestamps). See
[01_HARDCODED_AUDIT §A](01_HARDCODED_AUDIT.md).

## Verification (real browser, against PG17/5433)

`.verify/verify_refactor.js` (Playwright) — **7/7**, re-run after every change:

```
[PASS] anonymous #admin deep-link does NOT open a demo portal · shows landing/login
[PASS] backend login issues a JWT (PostgreSQL auth)
[PASS] restored JWT session → admin portal mounts
[PASS] portal loaded data FROM the backend API · 6 successful /api calls
[PASS] backend reports real bays from PostgreSQL · 7 bays
[PASS] no uncaught JS errors
[PASS] no failed app requests
```

Plus the backend remained green on PostgreSQL (`bsms` @ PG17:5433): the earlier
10/10 API verification ([../../DATABASE_SETUP_REPORT.md](../../DATABASE_SETUP_REPORT.md)).

## Honestly remaining

Now-**unreachable** demo code (components + `localStorage` stores) still exists in the
source as dead code. It never renders or runs, so it is not a functional violation, but
it should be physically deleted for cleanliness. Exact list + safe procedure:
[REMAINING_HARDCODED_ITEMS.md](../../REMAINING_HARDCODED_ITEMS.md).
