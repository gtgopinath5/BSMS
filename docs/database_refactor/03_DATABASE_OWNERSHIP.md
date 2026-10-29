# 03 — DATABASE OWNERSHIP

> One owner per business entity = PostgreSQL `bsms` (PG17:5433). Full table below;
> the authoritative, relationship-level version is
> [../../SINGLE_SOURCE_OF_TRUTH.md](../../SINGLE_SOURCE_OF_TRUTH.md) and
> [../../workflow-details/OWNERSHIP_MAP.md](../../workflow-details/OWNERSHIP_MAP.md).

| Entity | Owner table | Notes |
|---|---|---|
| Users / auth / roles | `users` | hashed passwords; JWT issued from here |
| Workers | `users` (role=worker) | |
| Bays | `bays` | |
| Worker↔bay | `bays.primary_worker_id` + `bay_temp_assignments` | resolved by `resolve_bay_worker()` — Bay Management is the only writer |
| Cameras | `bay_cameras` | 1:1 with bay |
| Timers / ESP32 | `timer_devices` | 1:1 with bay; MQTT topic derived from `bays.bay_number` |
| Jobs | `job_cards` | |
| Queue | `job_queue` | worker column = projection of the bay's worker |
| Service sessions | `service_sessions` | worker frozen at START (history) |
| Recordings | `recording_sessions` | |
| Notifications | `notifications` | |
| Audit | `audit_logs` | append-only |
| Branches | `branches` | |
| Parts | `parts_master`, `imported_files`, `unit_conversion_settings` | |
| KPIs / reports | **computed** from the above (no stored duplicate) | |

**No second owner anywhere:** no browser store, no in-memory dict, no hardcoded array
holds business state (the frontend `BAYS`/`WORKERS` arrays were deleted; demo stores are
unreachable). See [../../REMAINING_HARDCODED_ITEMS.md](../../REMAINING_HARDCODED_ITEMS.md).
