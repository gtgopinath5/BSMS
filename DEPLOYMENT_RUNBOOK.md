# Baywatch — Deployment Runbook

Operations for a production deploy. Pairs with `PRODUCTION_READINESS.md`.
Nothing here changes product behavior; it is configuration + operations only.

---

## 0. One-time secret generation
```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # INTEGRATION_SECRET_KEY (dedicated Fernet/encryption key)
```

## 1. Environment
```bash
cd backend
cp .env.production.example .env.production
# Fill: DATABASE_URL (PostgreSQL), JWT_SECRET, INTEGRATION_SECRET_KEY,
#       CUSTOMER_WATCH_BASE_URL (public https), CORS_ORIGINS (real origin),
#       BW_MEDIA_ROOT (persistent volume), POSTGRES_PASSWORD.
# Keep SEED_ON_STARTUP=false. .env.production is gitignored — never commit it.
```
`APP_ENV=production` turns on **fail-fast validation**: the app refuses to start on a
weak/default JWT, empty Fernet key, SQLite URL, `SEED_ON_STARTUP=true`, localhost
watch URL, wildcard CORS, or a non-writable media root. Optional integrations
(Drive/WhatsApp/MQTT) only warn.

## 2. First-boot bootstrap (creates the first admin safely)
The seed creates default-password users, so it is blocked in production. Bootstrap once:
```bash
# On staging or a one-off boot WITHOUT APP_ENV=production:
SEED_ON_STARTUP=true APP_ENV=development python run.py
# → log in as master/admin, CHANGE EVERY PASSWORD via the UI/API,
#   create your real admin(s), then stop.
# Deploy for real with APP_ENV=production and SEED_ON_STARTUP=false.
```

## 3. Start / stop (Docker, production)
```bash
cd backend
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
# with the bundled nginx (serves frontend + same-origin API):
docker compose -f docker-compose.prod.yml --profile with-nginx --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml logs -f fastapi      # tail logs
docker compose -f docker-compose.prod.yml down                 # stop (keeps volumes)
```
**Single web process only** — the recording scheduler + MQTT client run in-process; do
**not** add `--workers >1`. Scale vertically.

## 4. Health & readiness
| Endpoint | Use | Behavior |
|---|---|---|
| `GET /health` | liveness / diagnostics | always 200; reports db, timer, mqtt, recording engine, drive |
| `GET /ready` | LB / orchestrator probe | **503** when DB down or media not writable; else 200 |
```bash
curl -fsS http://HOST/ready  && echo READY        # exits non-zero on 503
curl  -s  http://HOST/health | jq .data
```

## 5. Database
- **Schema:** auto via `create_all` + idempotent `ensure_*_schema()` ALTERs at startup
  (additive, never destructive — see PRODUCTION_READINESS.md). No Alembic migrations.
- **Verify after deploy (read-only):** `bash scripts/schema_verify.sh`
- **Backup (read-only `pg_dump -Fc`, keeps newest 14):** `bash scripts/backup.sh`
  - Schedule via cron, e.g. nightly: `0 2 * * * cd /srv/baywatch/backend && bash scripts/backup.sh >> /var/log/bw-backup.log 2>&1`
- **Restore drill (guarded — refuses non-empty DB without --force, asks to confirm):**
  `bash scripts/restore.sh backups/baywatch_YYYYMMDD_HHMMSS.dump`
- **Never** run `create_all`/scripts against prod expecting a reset — nothing here drops data.

## 6. Storage / recordings
- Recordings live under `BW_MEDIA_ROOT` (a **persistent** volume — `media:` in prod compose).
- Retention = `RECORDING_RETENTION_DAYS` (14). At expiry customer access stops; an
  **un-archived** recording's local copy is **held** ("Expired · Not archived"), never
  auto-deleted — resolve via Storage Management (Retry / Verify / Delete).
- Google Drive archival is optional. To enable real uploads, add to `requirements.txt`
  and rebuild: `google-api-python-client`, `google-auth` (the code already reads config
  via `integration_config`). Unconfigured → recordings stay on local SSD (honest).
- Monitor disk: alert when the media volume crosses ~80%.

## 7. Secrets (where each lives)
| Secret | Source | Notes |
|---|---|---|
| `JWT_SECRET` | env | rotating logs everyone out (expected) |
| `INTEGRATION_SECRET_KEY` | env | Fernet key for provider secrets at rest |
| Provider creds (Drive/WhatsApp/MQTT/RTSP/MSG91/SendGrid) | DB (encrypted) via Integrations UI, or env fallback | masked in API; never in logs/DOM |
| `POSTGRES_PASSWORD` | env (prod compose) | also embedded in `DATABASE_URL` |

**Rotate now:** a real `JWT_SECRET` was previously written to `backups/.env_*.bak`. It is
now gitignored, but treat it as exposed — generate a new `JWT_SECRET` and redeploy.

## 8. Git hygiene (one-time)
```bash
# .gitignore now blocks new secrets/dumps/media. Two strays are already tracked:
git rm --cached baywatch.db
git rm -r --cached backend/media    # keeps files on disk, stops tracking them
git commit -m "chore: stop tracking local db + media"
```

## 9. Rollback
```bash
# App: redeploy the previous image/tag (schema is additive, so older code runs on a newer DB).
docker compose -f docker-compose.prod.yml up -d --build   # after checking out the prior commit/tag
# Data: restore the last good dump (guarded):
bash scripts/restore.sh backups/<previous>.dump --force
```

## 10. Upgrade
1. `bash scripts/backup.sh` (take a fresh dump first).
2. Deploy new code; startup runs `create_all` + `ensure_*_schema()` (adds any new columns).
3. `bash scripts/schema_verify.sh` then `curl /ready`.
4. Smoke: `bash .verify/startup_check.sh` (logins + subsystem health).

## 11. Troubleshooting
| Symptom | Likely cause | Action |
|---|---|---|
| App won't start in prod, logs "Production startup blocked …" | a real config blocker | fix the named setting(s) in `.env.production` (no secret values are logged) |
| `/ready` 503 | DB unreachable or media not writable | check Postgres health + `BW_MEDIA_ROOT` mount/permissions |
| Customer watch link opens "Loading…" | frontend not same-origin / `CUSTOMER_WATCH_BASE_URL` wrong | use the nginx profile or point the URL at the backend's public origin |
| Duplicate retention sweeps / MQTT drops | multiple web workers | run a single web process |
| Drive "unreachable" | libs missing or creds unset | add Drive libs + configure via Integrations |
