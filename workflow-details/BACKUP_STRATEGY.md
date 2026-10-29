# BACKUP_STRATEGY — Phase 12

> What to back up, how often, and how to restore. Goal: lose **nothing** that is the
> system of record, and be able to rebuild a mini-PC from bare metal.

## What must be backed up (by criticality)

| Asset | Store | Criticality | Method | Frequency |
|---|---|---|---|---|
| **System of record** | PostgreSQL | 🔴 critical | `pg_dump` (logical) + WAL archiving (PITR) | dump nightly · WAL continuous |
| **Secrets / config** | `backend/.env` | 🔴 critical | encrypted copy off-box (secrets manager / sealed file) | on every change |
| **Active timers** | Redis | 🟠 important | **AOF** (`appendonly yes`) on local disk | continuous (Redis-managed) |
| **Recordings (recent)** | local SSD `/media` | 🟠 important | archived to **Google Drive** by the scheduler, then pruned | per sweep (6 h) |
| **Recordings (archive)** | Google Drive | 🟢 durable | Google-side redundancy | — |
| **ESP32 firmware** | `firmware/esp32_bay_timer` | 🟢 in git | source control | per release |

> **Redis is not a backup target for *history*** — completed timers are written to
> Postgres and removed from Redis. AOF exists only so **in-flight** timers survive a
> Redis restart. The authoritative history is always Postgres.

## PostgreSQL — the one that matters

**Nightly logical dump** (simple, portable):
```bash
pg_dump --format=custom --no-owner baywatch \
  > /backups/baywatch-$(date +%F).dump          # keep 30 days, ship off-box
```

**Continuous WAL archiving for point-in-time recovery** (recommended for prod):
```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /backups/wal/%f && cp %p /backups/wal/%f'
```
→ RPO ≈ the WAL segment in flight (seconds–minutes). Restore = base backup + replay.

**Restore (logical):**
```bash
createdb baywatch_restore
pg_restore --no-owner -d baywatch_restore /backups/baywatch-YYYY-MM-DD.dump
# verify row counts, then point DATABASE_URL at it (or rename)
```

## Redis AOF (timer durability)

```ini
# redis.conf — REQUIRED in production
appendonly yes
appendfsync everysec
```
With AOF on, a Redis restart replays the append log and `/health` reports
`timer_persistent: true`. **Verify after deploy:**
`curl localhost:8000/health | jq .data.timer_persistent` → must be `true`.

## Media (`/media`) & Google Drive

- The scheduler already implements **archive-then-prune**: a recording is uploaded,
  size-verified, the Drive link persisted, and only **then** is the local copy
  removed (`scheduler_service._upload_one`). A failed upload **keeps** the local file
  and retries — so media is never lost to a transient Drive outage.
- 14-day **retention** then deletes Drive + local and tombstones the row
  (`RETENTION_CLEANUP` audited). Backups of `/media` are therefore optional; treat
  Drive as the archive of record once `upload_status = uploaded`.
- **If Drive is not configured**, `/media` *is* the only copy — back it up (rsync to
  NAS nightly) until credentials are added. `system-health.drive.status = "off"` and
  `queues.drive_pending` tell you you're in this mode.

## `.env` / secrets

Never in git. Store an encrypted copy (e.g. `age`/`sops` sealed file or a secrets
manager). Losing `jwt_secret` invalidates all sessions (recoverable — users re-login);
losing the **DB credentials** or **Drive service-account** is the real risk — keep them
in the same vault as the DB backups.

## Backup verification (don't trust an untested backup)

| Check | Cadence |
|---|---|
| Restore last night's dump into a scratch DB, run `.verify/bw_verify.py` against a backend pointed at it | weekly |
| `pg_restore --list` parses without error | nightly (automated) |
| `/health.data.timer_persistent == true` | on every deploy |
| A recording reaches `upload_status = uploaded` and its Drive link opens | after enabling Drive |

## RPO / RTO summary

| Asset | RPO (data loss window) | RTO (restore time) |
|---|---|---|
| Postgres (with WAL) | seconds–minutes | minutes (logical) / longer (PITR) |
| Postgres (dump only) | up to 24 h | minutes |
| Redis timers | ≤ 1 s (AOF) | seconds (replay on restart) |
| Media (post-archive) | 0 (on Drive) | n/a |

See [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) for the step-by-step rebuild runbook.
