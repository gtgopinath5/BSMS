# DEPLOYMENT_GUIDE — Phase 12

> Fresh production install of Baywatch Service OS on a service-center mini-PC (Linux).
> Dev/zero-config defaults to SQLite + in-memory timers; **production needs Postgres +
> Redis(AOF) + Mosquitto + FFmpeg**.

## 1. Prerequisites (host packages)

```bash
# Debian/Ubuntu example
sudo apt update && sudo apt install -y \
  python3.12 python3.12-venv \
  postgresql-16 redis-server mosquitto mosquitto-clients \
  ffmpeg \
  libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \   # WeasyPrint (completion PDFs)
  tesseract-ocr                                     # parts OCR fallback (optional)
```

## 2. Datastores

```bash
# PostgreSQL
sudo -u postgres createuser baywatch --pwprompt
sudo -u postgres createdb baywatch -O baywatch

# Redis — REQUIRED: enable AOF so timers survive a Redis restart
sudo sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
sudo systemctl enable --now redis-server

# Mosquitto (lock down in prod: auth + ACLs; here: enable)
sudo systemctl enable --now mosquitto
```

## 3. App + Python env

```bash
git clone <repo> /opt/baywatch && cd /opt/baywatch/backend
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## 4. Configure `.env` (production values)

`/opt/baywatch/backend/.env`:
```ini
DATABASE_URL=postgresql+psycopg://baywatch:****@localhost:5432/baywatch
REDIS_URL=redis://localhost:6379/0
JWT_SECRET=<64+ random chars>          # openssl rand -hex 48
JWT_EXPIRE_MINUTES=720
MQTT_BROKER_HOST=localhost
MQTT_BROKER_PORT=1883
MQTT_ENABLED=true
RECORDING_RETENTION_DAYS=14
CORS_ORIGINS=https://ops.yourshop.local,http://<mini-pc-ip>:7890
SEED_ON_STARTUP=false                  # true ONLY for the very first boot
# optional integrations — leave blank to keep dormant:
GOOGLE_DRIVE_CREDENTIALS=/opt/baywatch/secrets/drive-sa.json
GOOGLE_DRIVE_FOLDER_ID=<folder id>
MSG91_AUTH_KEY=...   SENDGRID_API_KEY=...
```

## 5. Database schema

The app **auto-creates tables on boot** (`init_db` + `ensure_*_schema` column adds).
For controlled production migrations use **Alembic** (already a dependency) — see
[UPGRADE_GUIDE.md](UPGRADE_GUIDE.md). First boot with `SEED_ON_STARTUP=true` seeds demo
users/bays; set it back to `false` immediately after and create real master/admin users.

## 6. systemd units

`/etc/systemd/system/baywatch-api.service`:
```ini
[Unit]
Description=Baywatch API
After=postgresql.service redis-server.service mosquitto.service
Requires=postgresql.service redis-server.service

[Service]
WorkingDirectory=/opt/baywatch/backend
EnvironmentFile=/opt/baywatch/backend/.env
# ONE worker owns the timer/MQTT/scheduler threads (see SERVER_ARCHITECTURE):
ExecStart=/opt/baywatch/backend/.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/baywatch-web.service`:
```ini
[Unit]
Description=Baywatch Frontend (static)
After=baywatch-api.service

[Service]
WorkingDirectory=/opt/baywatch/frontend
ExecStart=/usr/bin/python3 serve.py        # serves React UMD on :7890, no build step
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now baywatch-api baywatch-web
```

> Put a reverse proxy (Caddy/nginx) in front for TLS + a single origin if exposing
> beyond the LAN; keep CORS aligned with the public origin.

## 7. Devices

- **Cameras** — add each via the admin *Camera Connection* page (RTSP URL + creds);
  one camera per bay. Test/Reconnect verifies reachability.
- **ESP32 timers** — flash `firmware/esp32_bay_timer` with the broker IP + bay number;
  pair via *Timer Connection*. On boot each sends `hello` and is auto-synced.

## 8. Post-deploy verification (must pass)

```bash
curl -s localhost:8000/health | jq                       # db:true, timer_persistent:true, mqtt.connected:true
curl -s localhost:8000/api/v1/platform/system-health -H "Authorization: Bearer <admin>" | jq .overall
/opt/baywatch/backend/.venv/bin/python3 .verify/bw_verify.py      # 37/37
/opt/baywatch/backend/.venv/bin/python3 .verify/bw_hardening.py   # 34/34
```

If `timer_persistent` is `false`, **stop** — Redis AOF is not on; fix before going live
(timers would be lost on the next Redis restart).

## 9. Harden (before real customers)

- `JWT_SECRET` is long + unique; demo seed users removed/passworded.
- `passlib[argon2]` or `[bcrypt]` enabled (requirements note pbkdf2 as the pure-python default).
- Mosquitto auth + ACLs; Redis bound to localhost (or password); Postgres least-priv user.
- Camera passwords are stored — encrypt at rest (noted in `models/camera_device.py`).
- Backups + monitoring wired ([BACKUP_STRATEGY.md](BACKUP_STRATEGY.md), [MAINTENANCE_GUIDE.md](MAINTENANCE_GUIDE.md)).
