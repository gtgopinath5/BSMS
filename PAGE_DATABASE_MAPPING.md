# PAGE_DATABASE_MAPPING

> Every portal page → the API it calls → the PostgreSQL table(s) behind it.
> After the refactor every page renders its `Live*` component (no demo branch), so this
> is the **complete** data path: **UI → `BW_API` → FastAPI route → service → PostgreSQL**.
> API client: [frontend/js/api.js](frontend/js/api.js). DB tables: `bsms` (PG17:5433).

## Admin portal ([pages/admin.jsx](frontend/pages/admin.jsx))

| Tab | Live component | API (`BW_API`) | Endpoint | Tables (R/W) |
|---|---|---|---|---|
| Live Bay Dashboard | LiveBayDashboard | `dashboard`, start/pause/resume/complete | `GET /bay-dashboard`, `POST /bay-dashboard/{bay}/…` | service_sessions, bays, camera_sessions, recording_sessions (R/W) |
| Bay Management | LiveBayManagement | `bayOperations`, `bayDetail`, `assignPrimaryWorker`, `tempAssignWorker`, `revertBayWorker` | `GET /bays/operations`, `/bays/{id}/detail`, `PUT/POST /bays/*` | bays, bay_temp_assignments, bay_cameras, timer_devices, users (R/W) |
| Camera Connection | LiveCameraConnection | `camerasList`, `pairCamera`, … | `GET/POST/PUT/DELETE /cameras*` | bay_cameras (R/W) |
| Timer Connection | LiveTimerConnection | `timersList`, `pairTimer`, restart… | `GET/POST/PUT/DELETE /timers*` | timer_devices (R/W); audit_logs (W) |
| Job Assignment / Queue | LiveJobAssignment | `queue`, `createJob`, `saveToQueue`, `assign`, `changeBay` | `GET /queue`, `POST /jobs/*`, `POST /queue/{id}/*` | job_cards, job_queue, service_sessions (R/W) |
| Parts Time | LivePartsTime | `partsListPaged`, `partsImportRows`, … | `GET/POST /parts*` | parts_master, imported_files, unit_conversion_settings (R/W) |
| Worker Management | LiveWorkerManagement | `workers`, `createWorker` | `GET/POST /workers` | users (R/W) |
| Leave Approvals | LiveLeaveApprovals | `leaveList`, approve/reject | `GET/POST /leave*` | leave_requests (R/W) |
| Branch Reports | LiveBranchReports | `branchSummary`, `workerPerformance` | `GET /reports/*` | service_sessions, users, bays (R) |
| Work Completion | LiveWorkCompletion | `workCompletion` | `GET /reports/work-completion` | service_sessions, recording_sessions (R) |
| Storage Management | LiveStorageManagement | `storageOverview`, syncNow, retry | `GET/POST /storage*` | recording_sessions (R/W) |
| Notifications / Search | BWNotifications / palette | `platformActivity`, `platformSearch` | `GET /platform/*` | audit_logs + all (R) |

## Master portal ([pages/master.jsx](frontend/pages/master.jsx))

| Tab | Live component | Endpoint | Tables |
|---|---|---|---|
| Overview | LiveMasterOverview | `GET /master/live-monitoring`, `/reports/*` | branches, bays, service_sessions, users (R) |
| Bay Monitoring | LiveMasterMonitoring | `GET /master/bay-monitoring` | bays, service_sessions, camera_sessions (R) |
| Branch Management | LiveMasterBranchManagement | `GET/POST /master/branches` | branches (R/W) |
| User Management | LiveMasterUserManagement | `GET/POST /master/admins`, `/workers` | users (R/W) |
| Analytics | LiveMasterAnalytics | `GET /master/global-analytics` | service_sessions, bays, branches (R) |
| Cameras / Timers / Storage | Live* (shared) | `/cameras`, `/timers`, `/storage` | bay_cameras, timer_devices, recording_sessions |
| System Settings | LiveSystemSettings | `GET /health`, `/platform/system-health` | (live system state) |
| Audit Logs | LiveAuditLogs | `GET /platform/activity` | audit_logs (R) |
| Work Completion | LiveWorkCompletion | `GET /reports/work-completion` | service_sessions, recording_sessions (R) |

## Worker portal ([pages/worker.jsx](frontend/pages/worker.jsx))

| Tab | Live component | Endpoint | Tables |
|---|---|---|---|
| Active Job | LiveWorkerActive | `GET /worker/active` (+ WS `/ws/worker`) | service_sessions, job_cards, recording_sessions (R) |
| Queue | LiveWorkerQueue | `GET /worker/queue` | job_queue, job_cards (R) |
| Attendance/Leave | LiveWorkerLeave | `GET/POST /leave/mine` | leave_requests (R/W) |
| History | LiveWorkerHistory | `GET /worker/history` | service_sessions, recording_sessions (R) |
| Profile | ProfilePage | (avatar local — see [REMAINING_HARDCODED_ITEMS](REMAINING_HARDCODED_ITEMS.md) §4) | users (R) |

## Customer portal ([pages/customer.jsx](frontend/pages/customer.jsx))

| Tab | Live component | Endpoint | Tables |
|---|---|---|---|
| Live Service | LiveCustomerService | `GET /customer/active-service` (+ WS) | service_sessions, recording_sessions (R) |
| History | LiveCustomerHistory | `GET /customer/service-history` | service_sessions, recording_sessions (R) |
| Notifications | LiveCustomerNotifications | `GET /customer/notifications` | notifications (R) |

## Entry flow

| Screen | Source |
|---|---|
| Landing (branch picker) | `BRANCHES` constant — **pre-auth bootstrap**, see [REMAINING_HARDCODED_ITEMS](REMAINING_HARDCODED_ITEMS.md) §3 |
| Role select | `ROLES` constant — app structure (which portals exist), not business data |
| Login | `POST /api/v1/auth/login` → PostgreSQL `users` (hashed password) → JWT |

Schema/relationship detail: [workflow-details/DATABASE_MAPPING.md](workflow-details/DATABASE_MAPPING.md)
and [workflow-details/API_FLOW.md](workflow-details/API_FLOW.md).
