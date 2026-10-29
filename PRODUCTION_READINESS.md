# Baywatch — Production Readiness

Operational hardening status for a safe production deploy. This pass added safe,
additive guards + production artifacts; it changed **no** product behavior, no
closed feature module, and did **not** rewrite the working dev Docker/compose stack.

> Profile switch: set **`APP_ENV=production`** to turn on fail-fast config validation.
> In development (default) the same checks only **warn** and never block boot.

---

## Risk register (found → addressed)

| # | Risk (found in discovery) | Severity | Addressed by |
|---|---|---|---|
| 1 | Default-credential seed (`admin123`/`master123`/`worker123`) on a fresh DB | High | `SEED_ON_STARTUP=false` in prod template; **startup validation blocks** prod boot if seed is on; bootstrap procedure documented |
| 2 | Weak default `JWT_SECRET` / empty `INTEGRATION_SECRET_KEY` | High | Startup validation **blocks** prod boot until strong secrets are set; prod env template uses `openssl rand -hex 32` placeholders |
| 3 | `DATABASE_URL` defaults to **SQLite** | High | Startup validation **blocks** SQLite in prod; prod template requires PostgreSQL |
| 4 | **Real JWT secret** in un-gitignored `backups/*.bak`; PG dumps loose in repo | High | New root `.gitignore` ignores `backups/ *.bak *.dump *.sql .env`; runbook instructs **rotating** the exposed secret |
| 5 | `/health` always 200 even when DB down; no LB readiness probe | Medium | New **`/ready`** returns **503** when DB unreachable / media not writable |
| 6 | `CUSTOMER_WATCH_BASE_URL` localhost → customer links break in prod | Medium | Startup validation **blocks** localhost in prod; documented in template + runbook |
| 7 | CORS could be opened to `*` | Medium | Startup validation **blocks** wildcard CORS in prod |
| 8 | Recording media on local path; no persistence guarantee | Medium | `BW_MEDIA_ROOT` documented + a named **`media`** volume in prod compose; `/ready` checks writability |
| 9 | Docker image excludes the frontend → backend-served customer-watch page 404s in-container | Medium | Optional **nginx** service in prod compose serves `frontend/` + same-origin reverse-proxy |
| 10 | No backup/restore tooling (only loose dumps) | Medium | `scripts/backup.sh` (read-only `pg_dump`), `scripts/restore.sh` (guarded), `scripts/schema_verify.sh` (read-only) |
| 11 | Google Drive libs missing from `requirements.txt` | Low-Med | Documented (add `google-api-python-client` + `google-auth` to enable real archival); degrades honestly otherwise |
| 12 | In-process scheduler + MQTT → multi-worker would double sweeps / clash MQTT id | Medium | **Single-web-worker** rule documented; prod compose runs one process, no `--workers` |
| 13 | Alembic present but empty; README implies migrations | Low | Documented: real mechanism = `create_all` + idempotent `ensure_*_schema()` ALTERs (additive, never destructive) |
| 14 | `baywatch.db` (0-byte) + `media/` already git-tracked | Low | `.gitignore` stops new ones; runbook lists `git rm --cached` cleanup (operator action) |

---

## Schema mechanism (important)

There are **no Alembic migrations**. Schema is created/upgraded at startup by:
1. `Base.metadata.create_all()` — creates any missing tables (idempotent; **never drops**).
2. Five idempotent `ensure_*_schema()` functions (`parts`, `jobs`, `bays`, `users`,
   `recordings`) that run `ALTER TABLE … ADD COLUMN` for columns added after first
   release — wrapped in try/except, safe on PostgreSQL **and** SQLite, **additive only**.

This is safe for production (no destructive DDL) but means schema changes ride in
application code, not migration files. `scripts/schema_verify.sh` confirms the
expected columns exist after a deploy.

---

## Acceptance checklist

- [x] Full app imports; `/health` works; **`/ready`** checks DB connectivity (+ media) and returns 503 when down
- [x] Production env template exists with **no real secrets** (placeholders only)
- [x] Required secrets validated in prod (JWT, Fernet, PG URL, non-localhost watch URL, locked CORS) — **fail-fast**
- [x] Optional integrations (Drive/WhatsApp/MQTT/camera) are **never** boot blockers — warnings/readiness only
- [x] PostgreSQL startup path + runtime `ensure_*_schema()` documented
- [x] Backup script (read-only `pg_dump`) + guarded restore + read-only schema verify
- [x] Recording volume / `BW_MEDIA_ROOT` documented; `customer_watch_base_url` prod requirement documented
- [x] No local paths / secrets in public APIs (verified in prior passes + this one)
- [x] No destructive DB behavior (no drop/reset/migration); dev stack untouched
- [x] Smoke: 0 backend tracebacks, 0 console errors; real :8000/:7890 unharmed; temp env cleaned up

See **DEPLOYMENT_RUNBOOK.md** for step-by-step operations.
