# 05 — SCHEMA MAPPING

> The 17 tables in `bsms`, with the modules that use them. Constraint/index/relationship
> detail is in [../../workflow-details/DATABASE_MAPPING.md](../../workflow-details/DATABASE_MAPPING.md)
> and [../../workflow-details/05_DATABASE_DOCUMENTATION.md](../../workflow-details/05_DATABASE_DOCUMENTATION.md).
> Live counts (PG17:5433): **17 tables · 30 FK constraints · 21 indexes · 7,408 rows**.

| Table | Rows | PK | FK | Used by (module) |
|---|--:|--:|--:|---|
| users | 6 | 1 | 1 | auth, workers, master, worker portal |
| branches | 4 | 1 | 0 | master, entry flow |
| bays | 7 | 1 | 2 | bay mgmt, dashboard, queue |
| bay_temp_assignments | 0 | 1 | 2 | bay mgmt (temp cover) |
| bay_cameras | 3 | 1 | 1 | camera connection, recording |
| timer_devices | 2 | 1 | 1 | timer connection, MQTT |
| job_cards | 46 | 1 | 3 | job assignment, worker/customer |
| job_queue | 11 | 1 | 3 | queue, worker queue |
| service_sessions | 10 | 1 | 4 | dashboard, worker active, reports |
| camera_sessions | 10 | 1 | 2 | recording, monitoring |
| recording_sessions | 10 | 1 | 4 | storage, recordings, completion |
| notifications | 0 | 1 | 1 | customer notifications |
| audit_logs | 1793 | 1 | 1 | activity feed, audit page |
| parts_master | 5492 | 1 | 1 | parts time, job estimation |
| imported_files | 1 | 1 | 1 | parts import history |
| unit_conversion_settings | 13 | 1 | 1 | parts time config |
| **TOTAL** | **7408** | | **30 FK** | **21 indexes** |

PKs are UUID/string (no SERIAL → 0 sequences). Schema is generated from the SQLAlchemy
models in `backend/app/models/` via `Base.metadata.create_all` (Alembic has no migrations
yet — see [../../workflow-details/UPGRADE_GUIDE.md](../../workflow-details/UPGRADE_GUIDE.md)).
