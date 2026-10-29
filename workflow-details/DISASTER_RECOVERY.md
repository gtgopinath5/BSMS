# DISASTER_RECOVERY — Phase 12 (operator runbook)

> Step-by-step recovery for the failures an operator will actually hit. Pairs with
> [FAILURE_RECOVERY.md](FAILURE_RECOVERY.md) (the *automatic* recovery code) — this doc
> is the *human* runbook for when something stays down.
>
> **First move for any incident:** `curl -s localhost:8000/api/v1/platform/system-health`
> (or `/health` if the API itself is suspect). The `overall` + `subsystems` tell you
> which box below to open.

## Severity ladder

| Level | Example | Customer impact |
|---|---|---|
| SEV-1 | Postgres down / mini-PC dead | platform offline |
| SEV-2 | Redis down / backend crash-looping | timers/jobs stalled, data safe |
| SEV-3 | MQTT/camera/Drive degraded | physical timers or recordings affected, jobs continue |

---

## Runbooks

### R1 — Backend crash / restart (SEV-2)
1. `systemctl restart baywatch-api`.
2. Watch the boot log for the recovery banner:
   `[timer][recovery] N active timer(s) restored from Redis` and
   `reconciled N live session(s)`.
3. If you see `Session … has NO active timer in Redis — admin must re-Start the bay`,
   that bay's timer was lost (Redis was flushed) — the admin re-Starts that one bay;
   the session and recording are intact, only the countdown restarts.
4. Confirm `system-health.overall` returns to `ok`.

### R2 — Redis down (SEV-2)
- Symptom: `timer_engine.persistent = false` (fell back to in-memory) or backend can't reach Redis.
- Fix: `systemctl restart redis`; confirm `appendonly yes` (timers replay from AOF).
- After Redis is back, **restart the backend** so it reconnects and `restore_all()` runs.
- Any bay that was mid-job while Redis was *fully* unavailable: re-Start that bay
  (session/recording preserved).

### R3 — PostgreSQL down (SEV-1)
1. `systemctl status postgresql`; restart it. If the data dir is corrupt → restore:
2. `createdb baywatch && pg_restore --no-owner -d baywatch /backups/baywatch-latest.dump`
   (then WAL replay for PITR if configured — see [BACKUP_STRATEGY.md](BACKUP_STRATEGY.md)).
3. Point `DATABASE_URL` at the restored DB; restart the backend.
4. Validate: run `.verify/bw_verify.py` (37 checks) against the restored stack.

### R4 — Mini-PC total loss (SEV-1, bare-metal rebuild)
1. Provision Linux; install Postgres 16, Redis (AOF), Mosquitto, FFmpeg, Python.
2. Restore `.env` from the vault and the **latest Postgres dump** (R3).
3. Deploy the app per [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md); `seed_on_startup=false`.
4. Bring up `baywatch-api`, `frontend`, `mosquitto`. Power the ESP32s — each sends
   `hello` on boot and is **resynced automatically** from backend state.
5. Recordings archived to Drive are already safe; local `/media` that hadn't uploaded
   is gone if the SSD was lost (RPO = last archive sweep) — accept or restore from the
   `/media` rsync if you kept one.
6. Full-stack validation: `.verify/bw_verify.py` **+** `.verify/bw_hardening.py`.

### R5 — MQTT broker down (SEV-3)
- Jobs, timers and recordings continue (backend is source of truth). Only the
  **physical ESP32 displays** freeze on their last value.
- Fix: `systemctl restart mosquitto`. paho auto-reconnects; on connect the backend
  `_publish_all_active()` repaints every ESP32 within 1 s. No manual resync needed.

### R6 — Camera offline (SEV-3)
- `system-health.cameras.offline` rises. Recording for that bay falls back to a real
  (synthetic) source so the file is never empty; the job is unaffected.
- Fix the camera/network; the next START/RESUME re-probes RTSP. Use the admin Camera
  Connection page → Test/Reconnect.

### R7 — Google Drive outage / upload failures (SEV-3)
- `queues.drive_failed > 0`. **Nothing is lost** — local copies are kept and retried
  every sweep. Use Storage Management → *Sync Now* / *Retry Upload* to force a pass.
- If credentials expired: replace the service-account JSON, restart, `Sync Now`.

### R8 — FFmpeg / recording wedged (SEV-3)
- `queues.recordings_interrupted > 0` after a crash. Prior segments are kept + playable.
- The next backend boot SIGKILL-reaps orphan ffmpeg and marks sessions `interrupted`;
  the admin re-Starts the bay to record cleanly from here.

## Targets

| Scenario | RTO | RPO |
|---|---|---|
| Backend restart (R1) | < 1 min | 0 (Redis + DB intact) |
| Redis restart (R2) | < 2 min | ≤ 1 s (AOF) |
| Postgres restore (R3) | minutes | seconds–min (WAL) / ≤ 24 h (dump) |
| Mini-PC rebuild (R4) | 1–2 h | last archive/dump |

## After any SEV-1/2: prove it's healthy

```bash
curl -s localhost:8000/api/v1/platform/system-health | jq .overall      # → "ok"
/path/backend/.venv/bin/python3 .verify/bw_verify.py                     # 37/37
/path/backend/.venv/bin/python3 .verify/bw_hardening.py                  # 34/34
```
