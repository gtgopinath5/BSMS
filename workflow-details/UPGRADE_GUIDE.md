# UPGRADE_GUIDE — Phase 12

> How to ship a new version to a running mini-PC without losing data or jobs, and how
> to roll back if it goes wrong.

## Golden rule

**Back up first, migrate explicitly, verify after.** A backend restart is safe (timers
restore from Redis, sessions reconcile), so the risk in an upgrade is almost always the
**schema** and **dependencies**, not the process restart.

## Pre-upgrade checklist

1. Read the release notes / diff for schema changes and new env vars.
2. **Backup**: `pg_dump --format=custom baywatch > /backups/pre-upgrade-$(date +%F-%H%M).dump`
   and snapshot `.env`.
3. Confirm current health is green (`system-health.overall == ok`) — don't upgrade on top
   of an existing incident.
4. Pick a quiet window (any bay mid-recording will be marked `interrupted` on restart
   and need a re-Start; prior segments are safe).

## Standard upgrade

```bash
cd /opt/baywatch && git fetch && git checkout <new-tag>
cd backend && . .venv/bin/activate
pip install -r requirements.txt            # dependency changes
```

### Schema migration — two mechanisms, know which one applies

| Mechanism | When | What it does |
|---|---|---|
| **`ensure_*_schema()`** (automatic, on boot) | additive **column** adds introduced after first release | `ensure_parts/job/bay/recording_schema` add new nullable columns idempotently — no action needed |
| **Alembic** (explicit) | tables, constraints, indexes, backfills, type changes | `alembic upgrade head` — **run before** starting the new backend |

> The deferred **DB-level UNIQUE index on `bays.bay_number`** (today enforced at the API)
> is exactly the kind of change that must go through Alembic (archived bays may share a
> number; the migration needs a data check first). Tracked in
> [DATABASE_MAPPING.md](DATABASE_MAPPING.md) and the
> [FINAL_PRODUCTION_CHECKLIST.md](FINAL_PRODUCTION_CHECKLIST.md) backlog.

```bash
# if the release ships Alembic migrations:
alembic upgrade head
```

### Restart + frontend
```bash
sudo systemctl restart baywatch-api
# frontend is static (React UMD, no build) — a git checkout is the deploy:
sudo systemctl restart baywatch-web        # or just hard-refresh; bump a cache-busting query if cached
```

## Post-upgrade verification (must pass before declaring done)

```bash
curl -s localhost:8000/health | jq .data.timer_persistent      # true
curl -s localhost:8000/api/v1/platform/system-health -H "Authorization: Bearer <admin>" | jq .overall   # ok
/opt/baywatch/backend/.venv/bin/python3 .verify/bw_verify.py       # 37/37
/opt/baywatch/backend/.venv/bin/python3 .verify/bw_hardening.py    # 34/34
```
Watch the boot log for the timer-recovery banner — it confirms in-flight jobs survived.

## Rollback

1. `systemctl stop baywatch-api`.
2. `git checkout <previous-tag>` and `pip install -r requirements.txt`.
3. **If a forward Alembic migration ran**, apply its downgrade
   (`alembic downgrade -1`) **or** restore the pre-upgrade dump (R3 in
   [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md)). Additive `ensure_*_schema` columns are
   backward-compatible (old code ignores new nullable columns) — usually no DB rollback needed.
4. `systemctl start baywatch-api`; re-run the verification suites.

## Zero/low-downtime notes

- The device side (timer/MQTT/scheduler) assumes **one** backend worker, so a true
  rolling blue-green needs the old process to release MQTT before the new one connects
  (paho `client_id="baywatch-backend"` — two of them will fight). For a single mini-PC,
  a fast `restart` (sub-second gap; timers restore from Redis) is the pragmatic path and
  loses no data.
- ESP32s and browsers self-heal: ESP32 `hello`-resyncs, browsers re-poll. No client
  action needed after an upgrade.

## Dependency / Python upgrades

Pin versions in `requirements.txt` (already pinned). Test a dependency bump in a staging
copy (restore a dump, point a second backend at it, run both suites) before production.
FFmpeg/cairo/pango/tesseract are **host** packages — upgrade them with the OS and
re-run `bw_verify` (recording + PDF paths exercise them).
