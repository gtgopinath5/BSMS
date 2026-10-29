# FINAL_POSTGRESQL_REPORT

> Final cleanup pass — *"every runtime business value must originate from
> PostgreSQL."* No new features; no UI redesign; working workflows untouched.
> Backend `:8000` → **PostgreSQL 17 `bsms` @ localhost:5433**, frontend `:7890`.

## Outcome

**Met and verified.** At runtime, all four portals render exclusively from
PostgreSQL; no demo arrays, demo stores, mock providers, or seeded values remain;
and no business data is written to the browser. Confirmed by a 25/25 real-browser
harness and a 12/0 startup check.

## What changed

**P1 — Branch picker → PostgreSQL.** Added public `GET /api/v1/branches`
(`backend/app/routers/branches.py`); the pre-login facility picker now renders the
4 real branches with live bay/crew/today counts. Fixed `app.jsx` to resolve the
post-login branch from the same endpoint (this was a real regression the harness
caught when the hardcoded `BRANCHES` array was emptied).

**P2 — Dead demo code removed.** 5 whole feature files deleted + demo components
excised from all four page files + surgical removal from 3 mixed feature files.
**204 insertions / 5,921 deletions across 16 files.** Shared helpers
(`RecordingUtil`, `VideoActions`, `readXlsx`, the partstime modals, `Avatar`)
were preserved. Detail: [DEAD_CODE_REMOVAL.md](DEAD_CODE_REMOVAL.md).

**P3 — Remaining hardcodes replaced with PostgreSQL.**
- Worker navbar identity `Karthik R. / EMP-802` → `user.name / user.id` (JWT).
- Worker profile → real identity + live performance (`/reports/worker-performance`);
  fabricated stats/specialties removed; fake "JOB-1055" toast removed.
- Customer status pill / session / notifications → `/customer/active-service` +
  `/customer/notifications` (were read from the demo `Workflow` store).
- Both shells previously pulled chrome data from demo stores (`useBayTimer`,
  `useWorkflow`); both rewired to backend polling.

**P4 — localStorage business stores removed.** `PartsStore`, `BayTimer`,
`Workflow`, `QueueStore`, `BayAudit` all deleted. Browser storage is now JWT +
api_base + theme/UI + a notification read-marker. Detail:
[LOCAL_STORAGE_CLEANUP.md](LOCAL_STORAGE_CLEANUP.md).

**Authentication.** `DEMO_CREDS` pre-fill removed; login form starts empty and
validates only against PostgreSQL. No `admin123` fallback, no offline/anonymous
entry (every portal requires a real JWT).

## Verification

| Tool | Result |
|---|---|
| `.verify/verify_portals.js` (4 roles, all tabs, real browser) | **25/25 ✅**, 0 JS errors, 0 failed requests |
| `.verify/startup_check.sh` (servers + auth + subsystems + DB data + browser) | **12 passed · 0 failed ✅** |
| Repo hardcode sweep | clean — see [FINAL_HARDCODE_AUDIT.md](FINAL_HARDCODE_AUDIT.md) |

## Honest remaining items

One business-ish value remains in the browser: **worker avatar photos**
(`bw_photos` localStorage), because `users` has no `photo_url` column. It degrades
to initials and is documented with a migration plan, alongside a few UI
placeholders (profile contact fields, shift window), in
[REMAINING_NON_DATABASE_ITEMS.md](REMAINING_NON_DATABASE_ITEMS.md). None of these
block the single-source-of-truth goal.

## The contract going forward

[docs/architecture/SINGLE_SOURCE_OF_TRUTH.md](docs/architecture/SINGLE_SOURCE_OF_TRUTH.md)
is the permanent architectural contract (entity → owner table + the short
allow-list of browser-stored values). Run `bash .verify/startup_check.sh` after
any change to confirm the stack stays PostgreSQL-backed.
