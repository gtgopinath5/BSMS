#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════
#  backup.sh — timestamped PostgreSQL backup (read-only; never mutates the DB).
#
#  Usage:   bash scripts/backup.sh [OUTPUT_DIR]
#  Reads DATABASE_URL from the environment or backend/.env. Refuses SQLite.
#  Produces a custom-format dump (restore with scripts/restore.sh).
# ════════════════════════════════════════════════════════════════════
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # backend/
OUT_DIR="${1:-$HERE/../backups}"

# Resolve DATABASE_URL (env wins; else parse backend/.env).
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ] && [ -f "$HERE/.env" ]; then
  DB_URL="$(grep -E '^DATABASE_URL=' "$HERE/.env" | head -1 | cut -d= -f2-)"
fi
if [ -z "$DB_URL" ]; then
  echo "✗ DATABASE_URL not set (env or backend/.env)"; exit 1
fi
case "$DB_URL" in
  sqlite*) echo "✗ DATABASE_URL is SQLite — nothing to pg_dump. Backup is for PostgreSQL only."; exit 1;;
esac

# pg_dump understands postgresql:// URIs but not the +psycopg driver suffix.
PG_URI="${DB_URL/postgresql+psycopg:/postgresql:}"
PG_URI="${PG_URI/postgresql+asyncpg:/postgresql:}"

mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
OUT="$OUT_DIR/baywatch_${TS}.dump"

echo "▸ backing up → $OUT"
pg_dump --format=custom --no-owner --no-privileges --dbname="$PG_URI" --file="$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "✅ backup complete · $OUT ($SIZE)"
echo "   restore with:  bash scripts/restore.sh \"$OUT\""

# Optional retention: keep the newest 14 dumps (comment out to keep all).
KEEP=14
ls -1t "$OUT_DIR"/baywatch_*.dump 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
  echo "   pruning old backup: $old"; rm -f "$old"
done
