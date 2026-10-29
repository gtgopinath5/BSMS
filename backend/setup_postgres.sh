#!/usr/bin/env bash
# One-shot PostgreSQL setup for Baywatch (macOS / Homebrew).
# Idempotent — safe to re-run. Creates the `baywatch` role + database that
# match DATABASE_URL=postgresql+psycopg://baywatch:baywatch@localhost:5432/baywatch
set -euo pipefail

PG=postgresql@16
# postgresql@16 is keg-only, so its binaries aren't on PATH by default:
export PATH="/opt/homebrew/opt/${PG}/bin:$PATH"

echo "▸ installing ${PG} (skips if present)…"
brew list --versions "${PG}" >/dev/null 2>&1 || brew install "${PG}"

echo "▸ starting ${PG}…"
brew services start "${PG}" >/dev/null

echo "▸ waiting for server…"
for _ in $(seq 1 30); do pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break; sleep 1; done
pg_isready -h localhost -p 5432

echo "▸ creating role + database…"
psql -d postgres -tc "SELECT 1 FROM pg_roles WHERE rolname='baywatch'" | grep -q 1 \
  || psql -d postgres -c "CREATE ROLE baywatch WITH LOGIN PASSWORD 'baywatch' CREATEDB;"
psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='baywatch'" | grep -q 1 \
  || psql -d postgres -c "CREATE DATABASE baywatch OWNER baywatch;"

echo "▸ verifying connection…"
PGPASSWORD=baywatch psql -h localhost -U baywatch -d baywatch -c "SELECT current_user, current_database();"

cat <<'EOF'

✅ PostgreSQL ready.

Next:
  cd backend
  cp -n .env.example .env           # if you don't have .env yet
  # ensure .env has:
  #   DATABASE_URL=postgresql+psycopg://baywatch:baywatch@localhost:5432/baywatch
  python3 -m venv .venv && source .venv/bin/activate
  pip install -r requirements.txt
  python run.py                     # tables auto-create + demo data seeds on boot

Tip: add Postgres tools to your shell PATH permanently:
  echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
EOF
