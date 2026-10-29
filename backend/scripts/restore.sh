#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  restore.sh — restore a PostgreSQL dump produced by scripts/backup.sh.
#  GUARDED: refuses to clobber a non-empty database without --force, and
#  always requires an explicit "yes" confirmation. Never targets SQLite.
#
#  Usage:   bash scripts/restore.sh <DUMP_FILE> [--force]
#  Target DB = $DATABASE_URL (env or backend/.env).
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # backend/
DUMP="${1:-}"
FORCE="${2:-}"

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "✗ usage: bash scripts/restore.sh <DUMP_FILE> [--force]"; exit 1
fi

DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f "$HERE/.env" ]; then
  DB_URL="$(grep -E '^DATABASE_URL=' "$HERE/.env" | head -1 | cut -d= -f2-)"
fi
[ -n "$DB_URL" ] || { echo "✗ DATABASE_URL not set"; exit 1; }
case "$DB_URL" in
  sqlite*) echo "✗ DATABASE_URL is SQLite — restore is for PostgreSQL only."; exit 1;;
esac
PG_URI="${DB_URL/postgresql+psycopg:/postgresql:}"
PG_URI="${PG_URI/postgresql+asyncpg:/postgresql:}"

# How many tables already exist in the target?
TABLES="$(psql "$PG_URI" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)"
echo "▸ target DB currently has $TABLES table(s) in schema 'public'"
if [ "${TABLES:-0}" -gt 0 ] && [ "$FORCE" != "--force" ]; then
  echo "✗ target is NOT empty. Refusing to overwrite without --force."
  echo "  Re-run:  bash scripts/restore.sh \"$DUMP\" --force   (this DROPS & recreates objects from the dump)"
  exit 1
fi

echo "⚠  This will restore '$DUMP' into:"
echo "     $(echo "$PG_URI" | sed -E 's,//[^@]+@,//***:***@,')"
read -r -p "   Type 'yes' to proceed: " CONFIRM
[ "$CONFIRM" = "yes" ] || { echo "aborted."; exit 1; }

echo "▸ restoring…"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$PG_URI" "$DUMP"
echo "✅ restore complete. Verify with:  bash scripts/schema_verify.sh"
