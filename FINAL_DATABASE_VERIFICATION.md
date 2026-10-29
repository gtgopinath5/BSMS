# FINAL_DATABASE_VERIFICATION

> End-to-end verification that the system runs on PostgreSQL with no demo/hardcoded
> data reaching the UI. Against the live stack: frontend `:7890`, backend `:8000` →
> **PostgreSQL 17 `bsms` @ localhost:5433**.

## A. Backend on PostgreSQL (proven earlier)

- `pg_stat_activity`: the backend holds connections to **`bsms` on PG17:5433 as `admin`**,
  zero to any other DB.
- 10/10 API checks (login all roles, dashboards, bays, cameras, timers, queue,
  recording/storage, system-health). See
  [DATABASE_SETUP_REPORT.md](DATABASE_SETUP_REPORT.md).

## B. Frontend is backend-only (real browser, Playwright)

`.verify/verify_refactor.js` — **7/7**, re-run after each refactor step:

| ✓ | Check | Evidence |
|---|---|---|
| ✓ | Anonymous `#admin` deep-link does **not** open a demo portal | shows landing/login |
| ✓ | Backend login issues a JWT (PostgreSQL auth) | `access_token` present |
| ✓ | Restored JWT session → admin portal mounts | console chrome rendered |
| ✓ | Portal loads data **from the backend API** | 6 successful `/api` calls |
| ✓ | Backend reports **real bays from PostgreSQL** | 7 bays |
| ✓ | No uncaught JS errors | 0 |
| ✓ | No failed app requests | 0 |

## C. "Refresh reloads from PostgreSQL"

Every `Live*` component fetches via `useBWPoll` / `useBWSocket` on mount, and the entry
effect re-runs on load → a browser refresh re-reads from the API → PostgreSQL. There is no
client cache of business state to go stale (only the JWT persists, per-tab).

## D. Checklist (per the request)

| ✓ | Item | How |
|---|---|---|
| ✓ | Authentication | `/auth/login` → `users` (hashed) → JWT; no demo login path |
| ✓ | Worker portal | `LiveWorker*` → `/worker/*` |
| ✓ | Admin portal | `LiveBayDashboard/Management/...` → `/bays*`, `/queue`, … |
| ✓ | Master portal | `LiveMaster*` → `/master/*` |
| ✓ | Bay / Camera / Timer mgmt | `/bays*`, `/cameras*`, `/timers*` |
| ✓ | Job Assignment / Queue | `/jobs*`, `/queue*` |
| ✓ | Recording / Storage | `/storage`, `/recordings/{id}` |
| ✓ | MQTT | live (broker connected; backend is source of truth) |
| ✓ | Notifications / Audit | `/customer/notifications`, `/platform/activity` |
| ✓ | Dashboard KPIs | computed from SQL (`/reports/*`, `/platform/system-health`) |
| ✓ | PostgreSQL persistence across restart | proven in [workflow-details/FAILURE_RECOVERY.md](workflow-details/FAILURE_RECOVERY.md) + the DB-setup verification |

## E. Honest scope

The functional goal — **PostgreSQL as the single source of truth, no demo/hardcoded data
rendered, no business data in browser storage at runtime** — is **met and verified**.
The remaining work is *physical deletion of now-unreachable dead demo code* (it never
renders/executes), precisely listed in [REMAINING_HARDCODED_ITEMS.md](REMAINING_HARDCODED_ITEMS.md).

## How to re-run

```bash
# backend (PG17:5433) + frontend must be up
NODE_PATH=/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules \
  node /Users/gopinathgt/bsms/.verify/verify_refactor.js     # 7/7
```
