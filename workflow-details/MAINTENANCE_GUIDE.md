# MAINTENANCE_GUIDE — Phase 12

> Routine operations to keep a Baywatch mini-PC running unattended. Most of the work
> is automatic; this is the human checklist around it.

## Daily (2 minutes)

| Check | How | Healthy |
|---|---|---|
| Platform up | `curl -s localhost:8000/api/v1/platform/system-health \| jq .overall` | `ok` |
| Timers persistent | same payload → `subsystems.timer_engine.persistent` | `true` |
| Devices online | `subsystems.cameras` / `esp32_timers` online vs total | online == total during business hours |
| Drive backlog | `queues.drive_pending` / `drive_failed` | pending drains, failed == 0 |
| Interrupted recordings | `queues.recordings_interrupted` | 0 |

The admin dashboards surface all of this; the curl is for headless/cron alerting.

## Weekly

- **Backup restore test** — restore last night's dump into a scratch DB and run
  `.verify/bw_verify.py` against it (proves the backup is real).
- **Disk headroom** — `df -h` on the `/media` volume; recordings auto-prune at 14 days
  but a Drive outage can back media up. `system-health` → `drive.status` tells you why.
- **Log review** — grep the backend log for `ERROR` (esp. the timer-recovery and
  Drive-failure lines).

## Monthly

- **DB hygiene** — `VACUUM (ANALYZE)` (autovacuum usually suffices; audit_logs grows
  forever by design — see Retention below).
- **Firmware** — check ESP32 firmware version drift in Timer Connection; roll OTA via
  the per-device Firmware button if needed (`TIMER_FIRMWARE_UPDATE` audited).
- **Dependency/security updates** — see [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md).
- **Rotate** any credentials due (Drive service account, MSG91/SendGrid keys).

## Recording retention (automatic)

- Sweeps run every **6 h** (`scheduler_service`): archive finished recordings to Drive,
  then at **14 days** (`recording_retention_days`) delete Drive + local and tombstone
  the row. Both archive and retention now record their **last run + outcome** in
  `system-health.scheduler` and write `DRIVE_UPLOAD` / `DRIVE_DELETE` /
  `RETENTION_CLEANUP` audit rows.
- To change the window: set `recording_retention_days` in `.env` and restart.
- To force a pass now: Storage Management → **Sync Now**.

## Audit log growth

`audit_logs` is **append-only by design** (it is the compliance trail). It grows slowly
(one row per admin/system action). If you must cap it, archive rows older than N months
to cold storage with a scheduled `pg_dump` of that table + `DELETE` — but prefer to keep
it: it is the source for [AUDIT_MATRIX.md](AUDIT_MATRIX.md) traceability.

## Log rotation

uvicorn/gunicorn + the `baywatch` logger write to stdout → capture via systemd journal
(`journalctl -u baywatch-api`) or a file with `logrotate` (daily, keep 14, compress).
FFmpeg per-session logs live under `media/recordings/{session}/ffmpeg.log` and are
removed with the media at retention.

## Routine restarts (safe)

A planned backend restart is **non-destructive** — the lifespan restores timers from
Redis, reconciles sessions, reaps orphan ffmpeg, and republishes ESP32 state. Prefer
restarting during a quiet window; any bay mid-recording will be marked `interrupted`
and needs a re-Start to resume capture (prior segments are kept).

## Health-alert thresholds (wire to your monitor)

| Alert when | Why |
|---|---|
| `/health` non-200 for > 60 s | platform down |
| `timer_engine.persistent == false` | timers won't survive a restart (Redis AOF off / down) |
| `drive_failed > 0` for > 1 sweep | archival stuck — media accumulating locally |
| `recordings_interrupted > 0` | a bay needs re-Start |
| `cameras.online < total` in hours | a camera/network fault |
