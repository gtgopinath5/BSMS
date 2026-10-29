# DATABASE_MIGRATION — baywatch → bsms (PostgreSQL → PostgreSQL)

> Date: 2026-06-12 · Method: `pg_dump` → create role+db → `pg_restore` (lossless,
> same server). The source database was **never dropped or modified** — this migration
> is fully reversible by re-pointing `DATABASE_URL`.

## 1. Current database — BEFORE migration (detected, not assumed)

| Property | Value |
|---|---|
| Type | **PostgreSQL 16.14** (Homebrew) — already Postgres, *not* SQLite |
| Host / Port | `localhost` / `5432` |
| Username | `baywatch` |
| Database | `baywatch` |
| Connection string | `postgresql+psycopg://baywatch:****@localhost:5432/baywatch` |
| Declared in | `backend/.env` (single source; `app/config.py` reads `DATABASE_URL`) |
| Alembic | scaffolded (`backend/alembic/`) but **0 migration files** — schema is built from SQLAlchemy models (`Base.metadata.create_all` + `ensure_*_schema`) |
| Stray file | root `baywatch.db` = 0-byte unused SQLite leftover (ignored) |

Detection sources checked: `.env`, `.env.example`, `backend/.env`, `app/config.py`,
`app/database.py`, `alembic.ini`, `alembic/versions/`, docker files (none), and the
**resolved runtime** `settings.database_url`.

## 2. New database — AFTER migration

| Property | Value |
|---|---|
| Type | PostgreSQL 16.14 (same server) |
| Host / Port | `localhost` / `5432` |
| Username | `admin` (created: `LOGIN`, `CREATEDB`) |
| Database | `bsms` (created: `OWNER admin`) |
| **Connection string used** | `postgresql+psycopg://admin:bsms@localhost:5432/bsms` |

> Note: the target `bsms` database and `admin` role **did not exist** at the start
> (`role "admin" does not exist`). They were created with the credentials you provided,
> using local superuser `gopinathgt`.

## 3. Backups taken (before any change)

| File | Contents |
|---|---|
| `backups/baywatch_pre_migration_20260612_230944.dump` | `pg_dump -Fc` (custom format, for `pg_restore`) — 399 KB |
| `backups/baywatch_pre_migration_20260612_230944.sql` | plain SQL (human-readable / portable) — 1.66 MB |
| `backups/.env.pre_migration_20260612_230944.bak` | the original `backend/.env` |

The source `baywatch` database also remains intact on the server as a live fallback.

## 4. Files modified

| File | Change |
|---|---|
| `backend/.env` | `DATABASE_URL` → `postgresql+psycopg://admin:bsms@localhost:5432/bsms`; the old URL kept as a commented rollback line. **This is the only config change** — no credentials are hardcoded anywhere else (`config.py` reads the env var). |

`alembic.ini` was **not** changed (no hardcoded URL; it uses `script_location` only).
No source code changed — the app is DB-agnostic via `DATABASE_URL`.

## 5. Schema + data migrated

Schema was carried by the dump (it reflects the live SQLAlchemy-generated tables).
**17 tables, 7,408 rows — exact parity** (source vs. target verified row-by-row):

| Table | Rows | | Table | Rows |
|---|---:|---|---|---:|
| audit_logs | 1793 | | leave_requests | 0 |
| bay_cameras | 3 | | notifications | 0 |
| bay_temp_assignments | 0 | | parts_master | 5492 |
| bays | 7 | | recording_sessions | 10 |
| branches | 4 | | service_sessions | 10 |
| camera_sessions | 10 | | timer_devices | 2 |
| imported_files | 1 | | unit_conversion_settings | 13 |
| job_cards | 46 | | users | 6 |
| job_queue | 11 | | **TOTAL** | **7408** |

**Relationships & IDs preserved:** primary keys are UUID/string (no SERIAL sequences),
so IDs were copied verbatim. FK spot-checks passed (`job_queue⋈job_cards`=11,
`service_sessions⋈bays`=10, **0 orphans**). Covered: Users · Workers · Bays · Jobs ·
Camera Registry · Timer Registry · Recording Sessions · Notifications · Audit Logs ·
Queue · Master Admin · Customer Data · all remaining tables.

## 6. Post-migration verification (10/10)

A fresh backend was booted against `bsms` (port 8001, MQTT off, seed off) and exercised:

| ✓ | Check |
|---|---|
| ✓ | Connection successful (`/health` db=true, timer=redis) |
| ✓ | Backend starts successfully on `bsms` |
| ✓ | Login works (admin / master / worker — migrated credentials) |
| ✓ | Dashboard / Bay Management loads (7 bays) |
| ✓ | Camera configuration works |
| ✓ | Timer configuration works |
| ✓ | Queue works |
| ✓ | Worker portal works |
| ✓ | Master admin works (`master`/`master123` → 4 branches) |
| ✓ | `bsms` contains all tables (17) and all records (7,408) |

`system-health` reports `database.engine = postgresql+psycopg` (i.e. `bsms`).

## 7. Warnings

- `pg_restore` completed with **0 errors / 0 warnings**.
- The **currently running** IDE backend (port 8000, started via `run.py` before this
  migration) is still connected to the old `baywatch` DB — `.env` changes are read at
  **startup**, and `--reload` only reacts to `.py` files. **Restart it to switch to `bsms`.**
- `SEED_ON_STARTUP=true` remains in `.env`; this is safe — `seed()` is idempotent and
  no-ops because `bsms` already has users. Set it to `false` if you prefer.
- Credentials `admin`/`bsms` are intentionally simple (your choice) — fine for local dev;
  use a strong password if this DB is ever exposed beyond localhost.

## 8. Manual steps remaining

1. **Restart your backend** so it picks up the new `.env`:
   - In your IDE: stop/restart the `run.py` process, **or** from a shell:
     `cd /Users/gopinathgt/bsms/backend && python run.py`
2. Confirm after restart:
   ```bash
   curl -s localhost:8000/health | jq .data.db                     # true
   curl -s localhost:8000/api/v1/platform/system-health \
     -H "Authorization: Bearer <admin token>" | jq .subsystems.database.engine
   # → "postgresql+psycopg"  (now serving bsms)
   ```
3. (Optional) once you're satisfied `bsms` is the permanent DB, the old `baywatch`
   database can be retired — but keep the dump in `backups/` regardless.

## Rollback (if ever needed)

Re-point `backend/.env` `DATABASE_URL` to
`postgresql+psycopg://baywatch:baywatch@localhost:5432/baywatch` and restart — the old
DB is untouched. Or restore the dump elsewhere:
`pg_restore --no-owner -d "postgresql://admin:bsms@localhost:5432/<db>" backups/baywatch_pre_migration_20260612_230944.dump`.
