#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  schema_verify.sh — READ-ONLY schema/health report. Never writes, drops,
#  alters, or seeds. Confirms the runtime ensure_*_schema() columns landed.
#
#  Usage:   bash scripts/schema_verify.sh
#  Target DB = $DATABASE_URL (env or backend/.env). Works on PostgreSQL.
# ════════════════════════════════════════════════════════════════════
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # backend/
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f "$HERE/.env" ]; then
  DB_URL="$(grep -E '^DATABASE_URL=' "$HERE/.env" | head -1 | cut -d= -f2-)"
fi
[ -n "$DB_URL" ] || { echo "✗ DATABASE_URL not set"; exit 1; }
case "$DB_URL" in
  sqlite*) echo "✗ DATABASE_URL is SQLite — this report is for PostgreSQL."; exit 1;;
esac
PG_URI="${DB_URL/postgresql+psycopg:/postgresql:}"
PG_URI="${PG_URI/postgresql+asyncpg:/postgresql:}"

echo "── Connection ─────────────────────────────────────────────"
psql "$PG_URI" -tAc "SELECT current_user || '@' || current_database()" || { echo "✗ cannot connect"; exit 1; }

echo "── Tables + row counts (live estimate) ────────────────────"
psql "$PG_URI" -P pager=off -c "
  SELECT relname AS table, n_live_tup AS rows
  FROM pg_stat_user_tables ORDER BY relname;"

echo "── Runtime ensure_*_schema() columns present? ─────────────"
# Expected additive columns the app adds at startup (see DEPLOYMENT_RUNBOOK.md).
check_cols() {
  local table="$1"; shift
  for col in "$@"; do
    local found
    found="$(psql "$PG_URI" -tAc "SELECT 1 FROM information_schema.columns WHERE table_name='$table' AND column_name='$col'")"
    if [ "$found" = "1" ]; then printf "  ✓ %s.%s\n" "$table" "$col"; else printf "  ✗ MISSING %s.%s\n" "$table" "$col"; fi
  done
}
check_cols recording_sessions upload_status upload_error uploaded_at drive_file_id delete_error last_verified_at
check_cols users last_login
echo "(read-only report — no changes were made)"
