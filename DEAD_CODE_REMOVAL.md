# DEAD_CODE_REMOVAL

> Physical removal of unreachable demo code, performed file-by-file with a
> 25/25 real-browser portal harness (`.verify/verify_portals.js`) re-run after
> every change. **Net: 204 insertions, 5,921 deletions across 16 files.**

## Whole files deleted (fully dead — no live reference)

| File | Lines | What it was | Live replacement |
|---|--:|---|---|
| `features/queue.jsx` | 750 | `UnifiedJobQueue` demo + `QueueStore` (localStorage) + `useQueue`/`WorkerJobQueue`/`RecentJobQueue` | `window.LiveJobAssignment` (live.jsx) |
| `features/workflow.jsx` | 322 | `Workflow`/`WorkflowEngine` demo store (localStorage) | live session APIs |
| `features/jobintake.jsx` | 683 | `JobIntake` demo (hardcoded job card + customer) | `window.LiveJobAssignment` |
| `features/baymgmt.jsx` | 197 | `BayManagement` demo + `BayAudit` localStorage log + `ROSTER` seed | `window.LiveBayManagement` |
| `features/baytimer.jsx` | 123 | `BayTimer` demo timer store (localStorage) | live timer via `/worker/active`, MQTT |

Their `<script>` tags were removed from `frontend/index.html`.

## Demo components deleted in-place (page shells kept)

The four portal shells now render `window.Live*` only; every demo component they
used to fall back to was removed:

| File | Before → After | Removed demo components |
|---|---|---|
| `pages/admin.jsx` | 791 → 126 | `BayDashboard`, `BayTile`, `BayCardV2`, `RecentCompletions`, `CompletionDetailModal`, `BayDetailDrawer`, `CompleteJobModal`, `JobAssignment`, `WorkerManagement`, `LeaveApprovals`, `BranchReports`, `BAYS`/`WORKERS` arrays |
| `pages/master.jsx` | 484 → 121 | `BRANCH_HEALTH`, `ActivityOrb`, `HealthCard`, `GlobalOverview`, `BranchManagement`, `AdminManagement`, `GlobalAnalytics`, `BayMonitoring` |
| `pages/worker.jsx` | 1082 → 249 | `ActiveJobPage`, `AttendancePage`, `WorkHistoryPage`, `JobQueuePage`, hardcoded `job`/`shift`/toast, `WORKER_HISTORY`, orphaned helpers (`TimerCard`/`JobCard`/`CameraFeed`/`Stats`) |
| `pages/customer.jsx` | 403 → 105 | `LiveServicePage`, `HistoryPage`, `NotifyPage`, `ServiceStepper`, `downloadCustomerPDF` |

## Mixed files — surgical removal of demo, shared helpers kept

| File | Before → After | Kept (used by live.jsx) | Removed (demo) |
|---|---|---|---|
| `features/completion.jsx` | 977 → 244 | `RecordingUtil`, `RecordingStatusBadge`, `RecordingPreviewModal`, `VideoActions` | `WorkCompletion`, `CreateWorkerModal`, `ROSTER`, `COMPLETIONS`, `genPDF`, `PdfPreviewModal`, `recFromCompletion`, `WorkerCompCard` |
| `features/partstime.jsx` | 771 → 232 | `extractFile`, `UnitConfig`, `FileTypeIcon`, `FileCard`, `DeleteConfirmModal`, `AuditDrawer` + constants | `ImportModal`, `FilePreviewModal`, `PartFormModal`, `PartsTime` |
| `features/partsstore.jsx` | 261 → 45 | `readXlsx` (client-side xlsx parser, used by live import) | `PartsStore` (localStorage), `useParts` |

## Method

For each symbol: grepped every reference across `live/live.jsx` + page shells.
A symbol referenced **only by its own definition** (or only by other demo code
being deleted in the same pass) is dead. `ConfirmDialog` was confirmed safe to
drop because live.jsx defines its **own**. Shared helpers (e.g.
`CreateWorkerModal`, `RecordingUtil`, `readXlsx`, the partstime modals) were
preserved. After every file, the 25/25 harness (admin/master/worker/customer +
landing) re-ran with **0 JS errors and 0 failed requests** — Babel transpiles
every `.jsx` at page load, so a syntax error in any file would surface there.

See [REMAINING_NON_DATABASE_ITEMS.md](REMAINING_NON_DATABASE_ITEMS.md) for the
two items intentionally **not** removed (worker-photo store, with a migration plan).
