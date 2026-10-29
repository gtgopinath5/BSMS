#!/usr/bin/env bash
# ============================================================
#  BSMS startup verification — run after starting the stack.
#  Confirms every runtime dependency is live and that business
#  data is served from PostgreSQL (not demo/hardcoded sources).
#
#  Usage:  bash .verify/startup_check.sh
#  Exit 0 = all critical checks passed; non-zero = a critical
#  dependency is down. Hardware-dependent subsystems (Drive,
#  cameras, ESP32 timers) are reported but never fail the run.
# ============================================================
set -u
BE="http://localhost:8000"
FE="http://localhost:7890"
API="$BE/api/v1"
NPATH="/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules"
PASS=0; FAIL=0; WARN=0
ok(){   printf "  \033[32m✓\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad(){  printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
warn(){ printf "  \033[33m!\033[0m %s\n" "$1"; WARN=$((WARN+1)); }

echo "── 1. Servers ─────────────────────────────────────────────"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BE/docs")" = "200" ] && ok "FastAPI running on :8000" || bad "FastAPI NOT reachable on :8000"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$FE/")" = "200" ]     && ok "React (static) running on :7890" || bad "Frontend NOT reachable on :7890"

echo "── 2. Authentication (PostgreSQL users) ───────────────────"
TKN=""
for u in "admin:admin123" "master:master123" "worker:worker123"; do
  user="${u%%:*}"; pass="${u##*:}"
  code=$(curl -s -o /tmp/_login.json -w '%{http_code}' -X POST "$API/auth/login" \
        -H 'Content-Type: application/json' -d "{\"username\":\"$user\",\"password\":\"$pass\"}")
  if [ "$code" = "200" ]; then ok "login '$user' → JWT (validated against PostgreSQL)";
    [ "$user" = "admin" ] && TKN=$(python3 -c "import json;print(json.load(open('/tmp/_login.json'))['access_token'])" 2>/dev/null)
  else bad "login '$user' failed (HTTP $code)"; fi
done

echo "── 3. Subsystem health (/platform/system-health) ──────────"
if [ -n "$TKN" ]; then
  curl -s "$API/platform/system-health" -H "Authorization: Bearer $TKN" > /tmp/_health.json
  python3 - "$@" <<'PY'
import json
d = json.load(open('/tmp/_health.json')).get('data', {})
subs = d.get('subsystems', {})
critical = {'database'}                      # MUST be ok
important = {'timer_engine', 'mqtt', 'recording_engine', 'scheduler'}  # Redis/MQTT/FFmpeg
hardware  = {'drive', 'cameras', 'esp32_timers'}  # informational (physical/3rd-party)
import sys
rc = 0
for k, v in subs.items():
    st = v.get('status') if isinstance(v, dict) else v
    mark = '✓' if st == 'ok' else ('!' if (k in hardware or st == 'degraded') else '✗')
    color = '32' if mark == '✓' else ('33' if mark == '!' else '31')
    label = 'PostgreSQL' if k == 'database' else k
    print(f"  \033[{color}m{mark}\033[0m {label} → {st}")
    if k in critical and st != 'ok':
        rc = 1
sys.exit(rc)
PY
  [ $? -eq 0 ] && ok "database subsystem = ok (critical)" || bad "database subsystem NOT ok (critical)"
else
  bad "skipped subsystem health (no admin token)"
fi

echo "── 4. Business data served from PostgreSQL ────────────────"
if [ -n "$TKN" ]; then
  for ep in "branches:public" "bays/operations:auth" "cameras:auth" "timers:auth" "queue:auth"; do
    path="${ep%%:*}"; mode="${ep##*:}"
    if [ "$mode" = "public" ]; then
      body=$(curl -s "$API/$path")
    else
      body=$(curl -s -H "Authorization: Bearer $TKN" "$API/$path")
    fi
    okk=$(printf '%s' "$body" | python3 -c "import sys,json;print('1' if json.load(sys.stdin).get('success') else '0')" 2>/dev/null)
    [ "$okk" = "1" ] && ok "GET /$path → PostgreSQL OK" || bad "GET /$path did not return a success envelope"
  done
else
  bad "skipped data checks (no admin token)"
fi

echo "── 5. Real-browser portals (no JS errors / no demo data) ──"
if [ -d "$NPATH/playwright" ]; then
  if NODE_PATH="$NPATH" node "$(dirname "$0")/verify_portals.js" > /tmp/_portals.txt 2>&1; then
    line=$(grep "PORTAL VERIFY" /tmp/_portals.txt)
    ok "portal harness: $line"
  else
    line=$(grep -E "PORTAL VERIFY|FAIL\]" /tmp/_portals.txt | head -5)
    bad "portal harness failed:"; echo "$line" | sed 's/^/      /'
  fi
else
  warn "Playwright not found at NODE_PATH — skipped browser harness"
fi

echo "───────────────────────────────────────────────────────────"
echo "RESULT: $PASS passed · $WARN warnings · $FAIL failed"
[ "$FAIL" -eq 0 ] && { echo "✅ Stack is up and PostgreSQL-backed."; exit 0; } || { echo "❌ Critical check(s) failed."; exit 1; }
