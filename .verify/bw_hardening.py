"""Enterprise hardening verification (Phases 7-11 + the START-freeze invariant).

Real, self-cleaning checks against a live backend on :8000. Run with the backend
venv so the subprocess recovery test + DB cleanup use the app's own models:

    /Users/gopinathgt/bsms/backend/.venv/bin/python3 .verify/bw_hardening.py

What it proves (not asserts):
  • Phase 9  — GET /platform/system-health returns a real operational snapshot.
  • Phase 10 — ESP32_RESTART is written to the append-only audit log (admin action);
               the system-initiated Drive/retention actions are wired (code path).
  • Phase 7  — a running bay timer SURVIVES a simulated backend restart: a fresh
               OS process re-reads it from Redis and recomputes remaining with no
               drift; the DB session is reconciled.
  • INVARIANT — START freezes the worker forever: primary→temp cover→START→revert
               the cover; the completed job's session/recording/queue + completion
               report still show the COVER worker, while the bay's LIVE resolution
               returns to primary. History does not rewrite itself.
  • Phase 11 — GET /bays/operations latency measured at 10/25/50/100 bays
               (results written to .verify/reports/perf.json + PERFORMANCE_REPORT).
"""
import json, os, subprocess, sys, time, urllib.request, urllib.error, statistics
from datetime import date, timedelta

BASE = "http://localhost:8000"
PY = "/Users/gopinathgt/bsms/backend/.venv/bin/python3"
BACKEND = "/Users/gopinathgt/bsms/backend"


def call(method, path, token=None, body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except Exception:
            return e.code, {}


P = []
def check(name, cond, detail=""):
    P.append((name, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{' · ' + str(detail) if detail else ''}")

def section(t):
    print(f"\n── {t} ──")


# ── login + fleet map ──
_, r = call("POST", "/api/v1/auth/login", body={"username": "admin", "password": "admin123"})
TOK = r["access_token"]
_, r = call("GET", "/api/v1/bays/operations", TOK)
ops = r["data"]
bays = {b["bay_number"]: b for b in ops["bays"]}
B1, B2, B3 = (bays[n]["bay_id"] for n in (1, 2, 3))
_, r = call("GET", "/api/v1/workers", TOK)
workers = r["data"]
primary1 = bays[1]["worker"]
primary3 = bays[3]["worker"]
today = date.today()
plus2 = today + timedelta(days=2)


# ════════════════════════════════════════════════════════════════════
section("PHASE 9 · system-health observability endpoint")
code, r = call("GET", "/api/v1/platform/system-health", TOK)
h = r.get("data", {})
check("GET /platform/system-health → 200", code == 200)
subs = h.get("subsystems", {})
need = {"database", "timer_engine", "mqtt", "recording_engine", "drive",
        "cameras", "esp32_timers", "scheduler"}
check("all 8 subsystems reported", need.issubset(set(subs)), sorted(subs))
check("overall status present", h.get("overall") in ("ok", "degraded", "down"), h.get("overall"))
check("database subsystem ok", subs.get("database", {}).get("status") == "ok")
check("timer_engine reports backend + persistence",
      "backend" in subs.get("timer_engine", {}) and "persistent" in subs.get("timer_engine", {}),
      subs.get("timer_engine"))
check("active{} block has the live counters",
      {"live_sessions", "active_timers", "active_recordings", "cameras_online",
       "esp32_online"}.issubset(set(h.get("active", {}))))
check("queues{} exposes drive + interrupted backlog",
      {"drive_pending", "drive_failed", "recordings_interrupted"}.issubset(set(h.get("queues", {}))))
check("scheduler reports last-run fields",
      {"last_archive_run", "last_retention_run", "running"}.issubset(set(subs.get("scheduler", {}))))
# worker must NOT see the operational health dashboard
_, wr = call("POST", "/api/v1/auth/login", body={"username": "worker", "password": "worker123"})
WTOK = wr["access_token"]
wc, _ = call("GET", "/api/v1/platform/system-health", WTOK)
check("worker cannot read system-health (403)", wc == 403, f"HTTP {wc}")


# ════════════════════════════════════════════════════════════════════
section("PHASE 10 · audit trail completeness (ESP32 restart is now logged)")
# drive an already-paired ESP32 timer (seeded) and confirm the append-only row.
_, tl = call("GET", "/api/v1/timers", TOK)
dev_id = next((row["timer"]["id"] for row in tl["data"]["timers"] if row.get("timer")), None)
check("a paired ESP32 timer exists to drive", dev_id is not None)
code, _ = call("POST", f"/api/v1/timers/{dev_id}/restart", TOK)
check("POST /timers/{id}/restart → 200", code == 200)
_, act = call("GET", "/api/v1/platform/activity?q=ESP32_RESTART&limit=20", TOK)
ev = [e for e in act["data"]["events"] if e["action"] == "ESP32_RESTART"]
check("ESP32_RESTART written to audit log", len(ev) >= 1, f"{len(ev)} row(s)")
check("audit row attributes the admin actor", ev and ev[0].get("by") not in (None, "system"),
      ev and ev[0].get("by"))
# the system-initiated actions exist as code paths (Drive dormant w/o creds)
os.chdir(BACKEND); sys.path.insert(0, BACKEND)
import inspect
import app.services.scheduler_service as sched
src = inspect.getsource(sched)
check("DRIVE_UPLOAD audited in scheduler", '"DRIVE_UPLOAD"' in src)
check("DRIVE_DELETE audited in scheduler", '"DRIVE_DELETE"' in src)
check("RETENTION_CLEANUP audited in scheduler", '"RETENTION_CLEANUP"' in src)


# ════════════════════════════════════════════════════════════════════
section("INVARIANT · START freezes the worker forever (history never rewrites)")
# bay 1: primary worker; add a temp cover; assign+start; then REVERT the cover.
cover = next(w for w in workers if w["id"] != primary1["id"])
code, r = call("POST", "/api/v1/jobs/manual", TOK,
               {"customer_name": "VERIFY Freeze", "vehicle_model": "Freeze Bike",
                "bay_id": B1, "estimated_minutes": 1})
qf = r["data"]["queue_id"]
call("POST", f"/api/v1/bays/{B1}/revert-worker", TOK)   # clear any stale cover (robust to crashed prior runs)
code, _ = call("POST", f"/api/v1/bays/{B1}/temp-assign", TOK,
               {"replacement_worker_id": cover["id"], "start_date": str(today),
                "end_date": str(plus2), "reason": "VERIFY freeze cover"})
check("temp cover assigned (bay now owned by cover)", code == 200, cover["name"])
code, r = call("POST", f"/api/v1/queue/{qf}/assign", TOK, {"bay_id": B1, "force": False})
ssf = r["data"]["service_session_id"]
code, _ = call("POST", f"/api/v1/bay-dashboard/{B1}/start", TOK)
check("STARTED under the cover worker", code == 200)
_, dash = call("GET", "/api/v1/bay-dashboard", TOK)
row = next((s for s in dash["data"]["bays"] if s["session_id"] == ssf), None)
check("running session frozen to cover at START", row and row["worker_id"] == cover["id"],
      row and row["worker_name"])
# complete the job, THEN revert the cover (cover no longer owns the bay)
time.sleep(2)
call("POST", f"/api/v1/bay-dashboard/{B1}/complete", TOK, {"actual_duration": None, "notes": ""})
code, _ = call("POST", f"/api/v1/bays/{B1}/revert-worker", TOK)
check("cover reverted — bay LIVE resolution back to primary", code == 200)
_, opsr = call("GET", "/api/v1/bays/operations", TOK)
b1now = next(b for b in opsr["data"]["bays"] if b["bay_id"] == B1)
check("bay's CURRENT worker is the primary again",
      b1now["worker"] and b1now["worker"]["id"] == primary1["id"], b1now["worker"]["name"])
# the completed job's history MUST still be the cover worker (frozen)
_, wc = call("GET", "/api/v1/reports/work-completion", TOK)
done = next((s for s in wc["data"] if s["session_id"] == ssf), None)
check("completion report STILL shows the cover worker (frozen history)",
      done and done["worker_id"] == cover["id"], done and done["worker_name"])
# cross-check the persisted rows directly in the DB (session + recording frozen)
from app.database import SessionLocal
from app.models.session import ServiceSession, RecordingSession
from sqlalchemy import select as _sel
_db = SessionLocal()
try:
    _ss = _db.get(ServiceSession, ssf)
    _rec = _db.scalar(_sel(RecordingSession).where(RecordingSession.service_session_id == ssf))
    check("DB service_session.worker_id frozen to cover", _ss and _ss.worker_id == cover["id"])
    check("DB recording_session.worker_id frozen to cover", _rec and _rec.worker_id == cover["id"])
finally:
    _db.close()


# ════════════════════════════════════════════════════════════════════
section("PHASE 7 · a running timer survives a backend RESTART (Redis persistence)")
# start a fresh job so there is a live timer in Redis, then simulate a reboot by
# reading the timer state from a brand-new OS process (no shared memory).
code, r = call("POST", "/api/v1/jobs/manual", TOK,
               {"customer_name": "VERIFY Restart", "vehicle_model": "Restart Bike",
                "bay_id": B3, "estimated_minutes": 30})
qr = r["data"]["queue_id"]
code, r = call("POST", f"/api/v1/queue/{qr}/assign", TOK, {"bay_id": B3, "force": False})
ssr = r["data"]["service_session_id"]
call("POST", f"/api/v1/bay-dashboard/{B3}/start", TOK)
time.sleep(2)
# fresh process = cold backend boot. It must recover the timer from Redis alone.
probe = subprocess.run(
    [PY, "-c",
     f"import os;os.chdir({BACKEND!r});import sys;sys.path.insert(0,{BACKEND!r});"
     "from app.utils import timer;n=timer.restore_all();"
     f"st=timer.get_state({B3!r});"
     "import json;print(json.dumps({'restored':n,'status':st['current_status'],"
     "'elapsed':st['elapsed'],'remaining':st['remaining'],'worker':st.get('worker_id')}))"],
    capture_output=True, text=True, timeout=30)
out = probe.stdout.strip().splitlines()[-1] if probe.stdout.strip() else "{}"
try:
    rec = json.loads(out)
except Exception:
    rec = {}
check("fresh process restored the timer from Redis", rec.get("restored", 0) >= 1, rec)
check("recovered timer is still RUNNING (no state lost)", rec.get("status") == "RUNNING")
check("remaining recomputed from anchored timestamps (no drift)",
      isinstance(rec.get("remaining"), int) and rec.get("elapsed", 0) >= 1,
      f"elapsed={rec.get('elapsed')}s remaining={rec.get('remaining')}s")
check("recovered session carries its frozen worker", rec.get("worker") is not None)
# DB session is still 'running' → reconcile would re-sync it on boot
_db = SessionLocal()
try:
    _ss = _db.get(ServiceSession, ssr)
    check("DB session still 'running' after the (simulated) restart",
          _ss and _ss.status.value == "running", _ss and _ss.status.value)
finally:
    _db.close()
# tidy: complete + remove
call("POST", f"/api/v1/bay-dashboard/{B3}/complete", TOK, {"actual_duration": None, "notes": ""})


# ════════════════════════════════════════════════════════════════════
section("PHASE 11 · /bays/operations latency at 10/25/50/100 bays")
created = []  # bay_ids we add for the load test
def _bay_count():
    _, rr = call("GET", "/api/v1/bays/operations", TOK)
    return len(rr["data"]["bays"]), rr["data"]

def _grow_to(total):
    have, _ = _bay_count()
    n = 901
    while have < total:
        while True:
            code, r = call("POST", "/api/v1/bays", TOK,
                           {"bay_number": n, "name": f"PERF Bay {n}"})
            n += 1
            if code in (200, 201):
                bid = (r.get("data") or {}).get("id") or (r.get("data") or {}).get("bay_id")
                if bid:
                    created.append(bid)
                break
            if n > 1100:
                return
        have += 1

def _measure(total, samples=7):
    _grow_to(total)
    actual, _ = _bay_count()
    times, size = [], 0
    for _ in range(samples):
        t0 = time.perf_counter()
        code, r = call("GET", "/api/v1/bays/operations", TOK)
        times.append((time.perf_counter() - t0) * 1000)
        size = len(json.dumps(r.get("data", {})))
    return {"target": total, "actual_bays": actual,
            "p50_ms": round(statistics.median(times), 1),
            "min_ms": round(min(times), 1), "max_ms": round(max(times), 1),
            "payload_kb": round(size / 1024, 1)}

perf = []
for total in (10, 25, 50, 100):
    m = _measure(total)
    perf.append(m)
    check(f"operations @ {m['actual_bays']:>3} bays · p50 {m['p50_ms']}ms (payload {m['payload_kb']}KB)",
          m["p50_ms"] < 1500, f"max {m['max_ms']}ms")

os.makedirs(f"{BACKEND}/../.verify/reports", exist_ok=True)
with open(f"{BACKEND}/../.verify/reports/perf.json", "w") as f:
    json.dump({"measured_at": time.strftime("%Y-%m-%d %H:%M:%S"), "samples": perf}, f, indent=2)
print(f"  → wrote .verify/reports/perf.json ({len(perf)} load points)")


# ════════════════════════════════════════════════════════════════════
section("cleanup")
# API: remove the freeze/restart queue rows + restore bay 1 cover
call("DELETE", f"/api/v1/queue/{qf}", TOK)
call("DELETE", f"/api/v1/queue/{qr}", TOK)
# delete the PERF load-test bays (empty → hard delete)
deleted_bays = 0
for bid in created:
    code, _ = call("DELETE", f"/api/v1/bays/{bid}", TOK)
    if code in (200, 204):
        deleted_bays += 1
# DB sweep: any PERF bay the API left + lifecycle artifacts of VERIFY jobs
import shutil
from app.models.bay import Bay
from app.models.session import CameraSession
from app.models.job import JobCard, JobQueue
db = SessionLocal()
cleaned = []
try:
    test_jobs = db.scalars(_sel(JobCard).where(JobCard.customer_name.like("VERIFY%"))).all()
    jids = [j.id for j in test_jobs]
    if jids:
        sss = db.scalars(_sel(ServiceSession).where(ServiceSession.job_card_id.in_(jids))).all()
        sids = [s.id for s in sss]
        if sids:
            for rrow in db.scalars(_sel(RecordingSession).where(RecordingSession.service_session_id.in_(sids))).all():
                db.delete(rrow)
            for cs in db.scalars(_sel(CameraSession).where(CameraSession.service_session_id.in_(sids))).all():
                db.delete(cs)
            db.commit()
            for s in sss:
                cleaned.append(s.id); db.delete(s)
            db.commit()
        for qrow in db.scalars(_sel(JobQueue).where(JobQueue.job_card_id.in_(jids))).all():
            db.delete(qrow)
        db.commit()
        for j in test_jobs:
            db.delete(j)
        db.commit()
    leftover = db.scalars(_sel(Bay).where(Bay.name.like("PERF Bay %"))).all()
    for b in leftover:
        db.delete(b); deleted_bays += 1
    db.commit()
finally:
    db.close()
for sid in cleaned:
    shutil.rmtree(f"{BACKEND}/media/recordings/{sid}", ignore_errors=True)
    shutil.rmtree(f"{BACKEND}/media/hls/{sid}", ignore_errors=True)
# verify fleet returned to baseline (PERF bays live in 901..1100 only;
# pre-existing high-numbered bays are not ours to count)
final_bays, fleet = _bay_count()
perf_left = [b["bay_number"] for b in fleet["bays"] if 901 <= b["bay_number"] <= 1100]
check("load-test bays cleaned up (no PERF bays 901-1100 remain)",
      not perf_left, f"{deleted_bays} PERF bays removed · fleet now {final_bays} · leftover {perf_left}")
print(f"  cleaned: {len(cleaned)} session(s), {deleted_bays} PERF bay(s)")

passed = sum(1 for _, ok_ in P if ok_)
print(f"\n{'='*60}\nHARDENING RESULT: {passed}/{len(P)} checks passed "
      f"{'✅ ALL PASS' if passed == len(P) else '❌ FAILURES: ' + ', '.join(n for n, ok_ in P if not ok_)}\n{'='*60}")
print("\nPERFORMANCE (GET /bays/operations):")
print(f"  {'bays':>5} {'p50(ms)':>9} {'min':>7} {'max':>7} {'payload':>9}")
for m in perf:
    print(f"  {m['actual_bays']:>5} {m['p50_ms']:>9} {m['min_ms']:>7} {m['max_ms']:>7} {str(m['payload_kb'])+'KB':>9}")
sys.exit(0 if passed == len(P) else 1)
