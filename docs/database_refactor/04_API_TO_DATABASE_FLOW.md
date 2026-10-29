# 04 — API → DATABASE FLOW

> The single data path for every workflow now that the demo fallback is gone:
>
> ```
> React UI  →  window.BW_API (fetch + JWT)  →  FastAPI route  →  service / workflow engine  →  SQLAlchemy  →  PostgreSQL
>                                                                                                          ↓
>                                                              {success,data,message}  ←  response  ←  rows
> ```
>
> Per-page endpoint→table detail: [../../PAGE_DATABASE_MAPPING.md](../../PAGE_DATABASE_MAPPING.md).
> Endpoint contract + the bay-first flows: [../../workflow-details/API_FLOW.md](../../workflow-details/API_FLOW.md).

## Representative workflows

**Login**
```
Login form → BW_API.login → POST /api/v1/auth/login → users (verify hash) → JWT → sessionStorage(bw_token)
```

**Create + assign a job (bay-first)**
```
Job Assignment → saveToQueue → POST /jobs/save-to-queue → resolve_bay_worker(bay) → job_cards + job_queue
Assign → POST /queue/{id}/assign → workflow_engine.create_from_assign → service_sessions + camera_sessions + recording_sessions
Go live → POST /bay-dashboard/{bay}/start → emit(JOB_STARTED) → Redis timer + FFmpeg + MQTT + notifications; worker frozen
```

**Dashboard KPI**
```
LiveBayManagement → bayOperations → GET /bays/operations → batched SQL (bays⋈users⋈cameras⋈timers⋈sessions) → counts
```

**Recording archival**
```
scheduler_service (6h) → archive_sweep → drive_service.upload → recording_sessions(drive_*) ; retention → delete + tombstone (audited)
```

No step reads a hardcoded array or a browser store — every read and write is PostgreSQL.
