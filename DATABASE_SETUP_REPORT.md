# DATABASE_SETUP_REPORT

> Date: 2026-06-12 · BSMS backend → your local pgAdmin PostgreSQL.
> **Final state: backend runs on the EDB PostgreSQL 17 server at `localhost:5433`,
> database `bsms` — the exact server your pgAdmin connects to — fully populated & verified.**

---

## 0. The root cause you correctly spotted: TWO Postgres servers

Your Mac is running **two separate PostgreSQL servers**, and my first attempt loaded the
data into the wrong one:

| Server | Port | Install | Superuser | Your data | pgAdmin uses it? |
|---|---|---|---|---|---|
| Homebrew **PostgreSQL 16.14** | **5432** | `/opt/homebrew/var/postgresql@16` | `gopinathgt` (trust) | first (mistaken) load went here | ❌ no |
| EDB **PostgreSQL 17.10** | **5433** | `/Library/PostgreSQL/17` | `postgres` / `admin` | ✅ **now here** | ✅ **yes** |

I confirmed the port by reading your pgAdmin's own registration
(`~/.pgadmin/pgadmin4.db`): `server='PostgreSQL 17' host=localhost port=5433 user=postgres`.
That's why your pgAdmin tree showed `bsms` with **no tables** — the data was on the
**5432** server, but pgAdmin was looking at **5433**. **Fixed:** the data is now on 5433,
and the backend points there too.

## 1. Final configuration (active)

| Property | Value |
|---|---|
| Server | EDB **PostgreSQL 17.10** |
| Host : Port | `localhost` : **5433** |
| Database | `bsms` |
| Username | `admin` (created on PG17; owns `bsms` + the `public` schema) |
| Password | `admin` |
| **Connection string** | `postgresql+psycopg://admin:admin@localhost:5433/bsms` |
| Defined in | `backend/.env` → `DATABASE_URL` (the only place; `config.py` reads it) |

## 2. Files modified

| File | Change |
|---|---|
| `backend/.env` | `DATABASE_URL` → `postgresql+psycopg://admin:admin@localhost:5433/bsms` (port `5432`→`5433`). **Only file changed.** |

DB-level changes on PG17/5433 (not files): `CREATE ROLE admin LOGIN PASSWORD 'admin'`,
`ALTER DATABASE bsms OWNER TO admin`, `ALTER SCHEMA public OWNER TO admin`.

## 3. Backups (nothing destroyed)

| File (in `backups/`) | What |
|---|---|
| `bsms_for_pg17_20260612_234759.dump` | source dump used to load PG17 |
| `bsms_20260612_232911.dump` · `baywatch_20260612_232911.dump` | earlier PG16 dumps |
| `baywatch_pre_migration_*.dump` / `.sql` · `.env_*.bak` | original migration backups |

The PG16:5432 server still holds `baywatch` **and** a full `bsms` copy — untouched, as
extra fallbacks.

## 4. Tables created on PG17/5433 (from the SQLAlchemy models, via the dump)

**17 tables · 30 foreign-key constraints · 21 indexes · 7,408 rows** — verified
byte-for-byte equal to the source (PG16 `bsms`):

| Table | Rows | | Table | Rows |
|---|--:|---|---|--:|
| audit_logs | 1793 | | leave_requests | 0 |
| bay_cameras | 3 | | notifications | 0 |
| bay_temp_assignments | 0 | | parts_master | 5492 |
| bays | 7 | | recording_sessions | 10 |
| branches | 4 | | service_sessions | 10 |
| camera_sessions | 10 | | timer_devices | 2 |
| imported_files | 1 | | unit_conversion_settings | 13 |
| job_cards | 46 | | users | 6 |
| job_queue | 11 | | **TOTAL** | **7408** |

Records preserved: IDs (UUID/string — copied verbatim), foreign keys (0 orphans),
relationships, and timestamps.

## 5. Backend status

- Stopped the process that was on PG16:5432; **restarted reading the new `.env` → PG17:5433.**
- Clean boot: `Application startup complete`, Redis persistent, MQTT connected, FFmpeg —
  **no tracebacks, no SQLAlchemy errors, no migration errors.**
- **Confirmed on PG17/5433** via `pg_stat_activity`: active `admin` connections to `bsms`
  on the 5433 server; `system-health.database.engine = postgresql+psycopg`.

## 6. Verification (10/10 on 5433)

✓ Backend running ✓ PostgreSQL 17/5433 connected ✓ no errors ✓ Login (admin/master/worker)
✓ Admin Dashboard ✓ Master Dashboard (4 branches) ✓ Worker Dashboard ✓ Bay Management (7 bays)
✓ Camera Management ✓ Timer Management (7 timers) ✓ Job Assignment/Queue ✓ Recording/Storage
(4 local) ✓ System health.

## 7. What you'll see in pgAdmin now

In **pgAdmin → PostgreSQL 17 → Databases → bsms → Schemas → public → Tables**, right-click
**Tables → Refresh**. You will now see all **17 tables**, with their **constraints (30 FKs)**,
**indexes (21)** and **rows (7,408)**. (The Sequences node stays empty — the schema uses
UUID/string primary keys, not SERIAL.)

## 8. Notes / remaining

| Item | Note |
|---|---|
| Two servers still running | PG16:5432 (Homebrew) + PG17:5433 (EDB). The app + your pgAdmin both use **5433** now. You can stop PG16 (`brew services stop postgresql@16`) if you don't need it — keep the dumps. |
| Backend process | I started a managed backend on `:8000`. If you use your IDE's Run button, stop this one first (it reads the same `.env` → 5433). |
| Local PG16 auth | `trust` (password not enforced); irrelevant now that the app uses PG17/5433 with real `admin`/`admin`. |
| `SEED_ON_STARTUP=true` | harmless — `seed()` is idempotent (bsms already has users). |

## Rollback

Re-point `backend/.env` `DATABASE_URL` to any preserved copy and restart, e.g.
`postgresql+psycopg://admin:admin@localhost:5432/bsms` (PG16 copy) or restore a dump:
`/Library/PostgreSQL/17/bin/pg_restore --no-owner -d "postgresql://admin:admin@localhost:5433/<db>" backups/bsms_for_pg17_20260612_234759.dump`.
