# PRODUCTION AUDIT — Bay-First Hardening (Phases 1–6)

> Date: 12 Jun 2026 · Scope: audit + fix of the bay-first implementation.
> **No new features were added** — every change below closes a found weakness or
> hardens an existing flow. Evidence: `.verify/bw_verify.py` (**37/37**),
> `.verify/verify_ui.js` (**34/34**, 0 JS errors, 0 failed app requests),
> screenshot galleries in `.verify/screenshots/` (`before/` vs current).

---

## 1. Architectural weaknesses found → fixed

| # | Weakness (found by auditing my own implementation) | Severity | Fix | Verified by |
|---|---|---|---|---|
| 1 | `POST /jobs/*` honored a client-sent `worker_id` when no bay was given (legacy fallback) — a worker-selection **API bypass** | HIGH | Strict bay-first: `bay_id` required, `worker_id` **ignored** | "worker_id WITHOUT bay → 400", "client worker_id is IGNORED" |
| 2 | `POST /queue/{id}/reassign` let an admin hand-pick a worker | HIGH | Endpoint + UI removed; moving a job = **Change Bay** (worker follows) | "reassign endpoint removed · 404" |
| 3 | `change-bay` stored a bay without moving the job — queue worker could contradict the bay | MED | Re-resolves and moves the job to the new bay's worker; null bay rejected | "change-bay re-resolves worker" |
| 4 | `assign?force=true` could go live on a **maintenance/disabled/unstaffed** bay (engine silently fell back to the queue's worker) | HIGH | `force` only overrides *busy*; explicit 409/409/400 guards | 3 "no bypass" checks |
| 5 | Temp cover added between **assign** and **START** was ignored — session kept the stale worker, and `_promote_next` could orphan the queue row | HIGH | `JOB_STARTED` re-resolves and syncs session + recording + queue row, then freezes | "live dashboard shows RE-RESOLVED worker", "completion log shows the temp worker" |
| 6 | Any user (admin/customer) could be set as a bay's primary or temp worker | MED | `_require_worker_role` on create/update/temp-assign (400) | 2 role-guard checks |
| 7 | Temp assignments accepted reversed dates, the primary as their own cover, and **overlapping covers** (ambiguous resolution) | MED | Date order, ≠ primary, one cover per bay (409); audited | 4 validation checks |
| 8 | `bay_number` unique only **per branch** — cross-branch duplicates would collide on MQTT topics `bay/{n}/*` and the ESP32s | HIGH | Global uniqueness on create/duplicate (409) | "duplicate bay_number (global) → 409" |
| 9 | Drawer Escape handler called parent setState inside a state updater (React "update during render" warning) | LOW | Ref-based confirm tracking | "zero JS errors" |
| 10 | Fleet header misaligned at tablet/mobile widths (header cell not collapsed with its data column) | LOW | Positional collapse for header+data cells | mobile/tablet screenshots |

## 2. Phase-by-phase outcome

**Phase 1 — Bay-first validation.** Worker selection now exists in exactly one
place (Bay Management). Every intake path (manual, PDF, queue, assign, dashboard)
resolves from the bay; resolution priority TEMP > PRIMARY > UNSTAFFED verified in
every case; unstaffed bays show 🔴 NO WORKER, are 🔒 disabled in pickers, expose
"Assign Primary Worker", and reject **all** API attempts incl. force.

**Phase 2 — Data consistency.** Ownership chain documented and audited in
[STATE_FLOW.md](STATE_FLOW.md): one source of truth per fact; `worker_id` on
sessions proven to be a START-frozen snapshot (history), not duplicate state;
MQTT topics derived (never stored) and protected by global bay numbers.

**Phase 3 — Fleet View.** KPI row, toolbar and table header are **structurally
sticky** (the page never scrolls; only the row area does) — verified pixel-exact
under scroll. Uniform 54 px rows. **Virtual scrolling** kicks in above 40 bays:
at 52 bays only ~25 rows exist in the DOM, window follows scroll and keyboard.
Responsive at 1680/1024/390 with aligned headers. Zero layout shift.

**Phase 4 — Drawer = control center.** 13 sections/actions: Bay Information ·
Worker (+perf) · Camera · Timer · ESP32 · MQTT broker · Current Service ·
Today's Jobs · History · Audit Timeline · Maintenance · Worker Replacement
(assign/replace/revert) · **Danger Zone** (Disable/Delete with inline
confirmation). Escape closes confirm → drawer → modal, innermost first.

**Phase 5 — Testing (real, self-cleaning).** 71 automated checks total:
primary/temp/revert · unstaffed/disabled/maintenance · queue/PDF/manual intake ·
**full live lifecycle** (assign → temp cover → START re-resolution → pause →
resume → complete → completion log → bay released) with real FFmpeg capture ·
worker portal (200s + 403 on admin data) · camera (CAM-03 from registry) and
timer (pair → topic `bay/2/timer` → unpair) mapping. Every artifact removed
afterwards (API + DB sweep + media); the 52-bay scale test created and deleted
45 real bays.

**Phase 6 — Documentation.** [BAY_FIRST_WORKFLOW](BAY_FIRST_WORKFLOW.md) ·
[WORKER_RESOLUTION](WORKER_RESOLUTION.md) · [CAMERA_TIMER_MAPPING](CAMERA_TIMER_MAPPING.md) ·
[STATE_MACHINE](STATE_MACHINE.md) · [API_FLOW](API_FLOW.md) ·
[UI_HIERARCHY](UI_HIERARCHY.md) · [DATABASE_MAPPING](DATABASE_MAPPING.md) ·
[STATE_FLOW](STATE_FLOW.md).

## 3. Before / after evidence

| | Before (`.verify/screenshots/before/`) | After (current) |
|---|---|---|
| Bay page | thin cards: bay + worker + status, ~50 % empty | `desktop/01` Fleet View: KPIs, filters, attention-sorted operational rows |
| Drawer | bay info + replace only | `desktop/03`, `desktop/09`: 13-section control center incl. audit timeline + danger zone |
| Job form | bay picker (first pass) | `desktop/06`: picker + resolved panel, **no worker dropdown anywhere** |
| Scale | untested beyond 7 bays | `desktop/10`: 52 bays, 25 DOM rows, chrome pinned |
| Original page (pre-redesign) | the user's screenshot (thin `LiveBayManagement` card grid) | — replaced entirely |

## 4. Honest remaining gaps (not silently skipped)

| Gap | Why deferred | Where tracked |
|---|---|---|
| DB-level UNIQUE index on `bays.bay_number` | needs an Alembic migration (archived bays may legitimately share numbers); runtime guard covers the API | [DATABASE_MAPPING.md](DATABASE_MAPPING.md) |
| Camera Test/Reconnect probe is simulated (stamps `last_seen`) | needs real hardware; production note in `routers/cameras.py` | [09_EXTERNAL_DEVICE_INTEGRATION.md](09_EXTERNAL_DEVICE_INTEGRATION.md) |
| Enterprise redesign of the *other* portals (Worker/Admin-rest/Master) to one design language | **explicitly out of scope of this no-new-features pass** — it is the agreed next engagement, to be specified by measurable requirements (design tokens, responsive/accessibility/performance audits, screenshot verification), not a subjective "score 100" | user's redesign brief |
| SendGrid email send is stubbed; Drive dormant without credentials | operator credentials required | [06_PROJECT_FRAMEWORKS.md](06_PROJECT_FRAMEWORKS.md) |

## 5. Verdict

The bay-first workflow is **production-ready within its scope**: no path in the
API or UI can select a worker for a job; non-operational bays cannot receive or
start work (including forced attempts); temp covers are validated, audited,
auto-restoring and honoured up to the START freeze point; the operational page
scales past 50 bays with stable chrome; and the whole claim set is backed by 71
repeatable automated checks plus visual evidence — not assertions.

---

## 6. Follow-on — Phases 7–12 (enterprise hardening)

A second pass took the system from "bay-first workflow is correct" to "runs every
day, recovers, is observable, traceable, and survives an attack." No new product
features; the additions are observability + audit completeness + one concurrency fix.

- **Code:** `GET /platform/system-health` (full operational snapshot), scheduler
  last-run tracking, `recording_service.active_count()`, audit gaps closed
  (`ESP32_RESTART`, `DRIVE_UPLOAD`, `DRIVE_DELETE`, `RETENTION_CLEANUP`), and an
  **assign-race fix** (row-lock → loser gets 409, not a 500).
- **Verification:** `+34` hardening checks (`.verify/bw_hardening.py`) and `+13`
  adversarial checks (`.verify/bw_breakit.py`) on top of the 37 — **84 total, run
  twice idempotently**. Restart recovery proven across a real process boundary; the
  START-freeze invariant proven end-to-end (Karthik→Murugan→START→revert→history stays Murugan).
- **Docs:** [FAILURE_RECOVERY](FAILURE_RECOVERY.md) · [OWNERSHIP_MAP](OWNERSHIP_MAP.md) ·
  [SYSTEM_HEALTH](SYSTEM_HEALTH.md) · [AUDIT_MATRIX](AUDIT_MATRIX.md) ·
  [PERFORMANCE_REPORT](PERFORMANCE_REPORT.md) · [SERVER_ARCHITECTURE](SERVER_ARCHITECTURE.md) ·
  [BACKUP_STRATEGY](BACKUP_STRATEGY.md) · [DISASTER_RECOVERY](DISASTER_RECOVERY.md) ·
  [MAINTENANCE_GUIDE](MAINTENANCE_GUIDE.md) · [DEPLOYMENT_GUIDE](DEPLOYMENT_GUIDE.md) ·
  [UPGRADE_GUIDE](UPGRADE_GUIDE.md) · [FINAL_PRODUCTION_CHECKLIST](FINAL_PRODUCTION_CHECKLIST.md).
