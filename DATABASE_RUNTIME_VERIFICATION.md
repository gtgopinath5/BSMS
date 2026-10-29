# DATABASE_RUNTIME_VERIFICATION

> Evidence that, at runtime, every portal runs on PostgreSQL with no demo data.
> Stack: frontend `:7890`, backend `:8000` → **PostgreSQL 17 `bsms` @ localhost:5433**.

## A. Real-browser portal harness — `.verify/verify_portals.js`

Logs into **all four roles** against the real backend, mounts each portal, clicks
through **every** sidebar tab, and asserts: portal chrome renders, the backend API
is hit, and **zero** uncaught JS errors / failed app requests. This harness was
re-run after every deletion during the cleanup.

```
PORTAL VERIFY: 25/25 passed ✅
  landing : branches from GET /api/v1/branches · Chennai,Mumbai,Pondicherry,Villupuram
  admin   : mounted · 11 tabs · 29 API 200s · 0 JS errors · 0 failed
  master  : mounted · 11 tabs · 18 API 200s · 0 JS errors · 0 failed
  worker  : mounted ·  5 tabs ·  7 API 200s · 0 JS errors · 0 failed
  customer: mounted ·  3 tabs ·  7 API 200s · 0 JS errors · 0 failed
```

## B. Startup verification — `.verify/startup_check.sh`

```
── 1. Servers ── FastAPI :8000 ✓ · React :7890 ✓
── 2. Authentication (PostgreSQL users) ── admin ✓ · master ✓ · worker ✓
── 3. Subsystem health ── PostgreSQL ✓ · timer_engine(Redis) ✓ · mqtt ✓ ·
       recording_engine ✓ · scheduler ✓ · drive/cameras/esp32 = informational
── 4. Business data from PostgreSQL ── /branches ✓ /bays/operations ✓
       /cameras ✓ /timers ✓ /queue ✓
── 5. Real-browser portals ── PORTAL VERIFY: 25/25 ✓
RESULT: 12 passed · 0 warnings · 0 failed → ✅ Stack is up and PostgreSQL-backed.
```

(`drive`/`cameras`/`esp32_timers` report `off`/`degraded` only because no physical
camera/ESP32 hardware or Google-Drive credentials are present in this environment;
they are explicitly **informational** and never fail the run.)

## C. Per-subsystem confirmation (the user's checklist)

| ✓ | Item | How it is PostgreSQL-backed |
|---|---|---|
| ✓ | login | `/auth/login` → `users` (hashed); no seeded/offline path |
| ✓ | admin | `window.LiveBayDashboard/Management/...` → `/bays*`, `/queue`, `/parts*` |
| ✓ | master admin | `window.LiveMaster*` → `/master/*` |
| ✓ | worker | `window.LiveWorker*` + chrome via `/worker/active` |
| ✓ | customer | `window.LiveCustomer*` + chrome via `/customer/active-service`, `/customer/notifications` |
| ✓ | camera | `/cameras` → `bay_cameras` |
| ✓ | timer | `/timers` → `timer_devices` |
| ✓ | MQTT | broker connected (system-health `mqtt = ok`) |
| ✓ | recordings | `/storage`, `/recordings/{id}` → `recording_sessions` |
| ✓ | queue | `/queue` → `job_queue` |
| ✓ | notifications | `/customer/notifications` → `notifications` |
| ✓ | audit logs | `/platform/activity` → `audit_logs` |
| ✓ | branches (pre-login) | `/branches` (public) → `branches` |

## D. "Refresh reloads from PostgreSQL"

Every `Live*` component and both rewired shells fetch via `useBWPoll`/`useBWSocket`
on mount; `app.jsx` resolves the branch from `/branches` on load. A browser refresh
re-reads from the API → PostgreSQL. No client cache of business state exists to go
stale (only the per-tab JWT persists).

## How to re-run

```bash
bash .verify/startup_check.sh        # full stack + browser, one command
# or just the browser portion:
NODE_PATH=/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules \
  node .verify/verify_portals.js     # 25/25
```
