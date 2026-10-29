"""Bay-first PRODUCTION verification suite (Phase 5).
Covers: primary/temp/revert resolution, unstaffed/disabled/maintenance guards,
API-bypass prevention, queue+PDF+manual intake rules, change-bay re-resolution,
full live lifecycle (assign→start→pause→resume→complete) incl. START-time worker
re-resolution, worker portal, camera+timer mapping. Self-cleaning (API + DB).
Run with the backend venv python so DB cleanup can use the app's own models:
    /Users/gopinathgt/bsms/backend/.venv/bin/python3 .verify/bw_verify.py
"""
import json, sys, time, urllib.request, urllib.error
from datetime import date, timedelta

BASE = "http://localhost:8000"

def call(method, path, token=None, body=None):
    headers = {"Content-Type": "application/json"}
    if token: headers["Authorization"] = "Bearer " + token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or "{}")
        except Exception: return e.code, {}

P = []
def check(name, cond, detail=""):
    P.append((name, bool(cond)))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}{' · ' + str(detail) if detail else ''}")

def section(t): print(f"\n── {t} ──")

# ── login ──
_, r = call("POST", "/api/v1/auth/login", body={"username": "admin", "password": "admin123"})
TOK = r["access_token"]

# ── fleet map ──
_, r = call("GET", "/api/v1/bays/operations", TOK)
ops = r["data"]; bays = {b["bay_number"]: b for b in ops["bays"]}
B1, B2, B3, B4, B5 = (bays[n]["bay_id"] for n in (1, 2, 3, 4, 5))
_, r = call("GET", "/api/v1/workers", TOK)
workers = r["data"]
primary3 = bays[3]["worker"]; primary1 = bays[1]["worker"]; primary4 = bays[4]["worker"]
temp_w = next(w for w in workers if w["id"] not in (primary3["id"], primary1["id"]))

section("PHASE 1 · resolution priority (temp > primary > unstaffed)")
check("staffed bays resolve primary", primary3 and primary3["name"] == "Imran Khan")
check("unstaffed bays flagged", bays[5]["status"] == "no_worker" and bays[6]["status"] == "no_worker")

section("PHASE 1 · API bypass prevention (job intake)")
code, r = call("POST", "/api/v1/jobs/manual", TOK,
               {"customer_name": "BYPASS worker-only", "worker_id": primary3["id"], "estimated_minutes": 30})
check("worker_id WITHOUT bay → 400 (no legacy path)", code == 400, r.get("message"))
code, r = call("POST", "/api/v1/jobs/manual", TOK,
               {"customer_name": "BYPASS unstaffed", "bay_id": B5, "estimated_minutes": 30})
check("unstaffed bay → 400 exact message", code == 400 and "Assign a primary worker" in r.get("message", ""))
code, r = call("POST", "/api/v1/jobs/manual", TOK,
               {"customer_name": "BYPASS hand-pick", "bay_id": B3, "worker_id": temp_w["id"], "estimated_minutes": 30})
qa = r["data"]["queue_id"] if code == 200 else None
_, q = call("GET", "/api/v1/queue", TOK)
owner = next((wid for wid, items in q["data"].items() for it in items if it["id"] == qa), None)
check("client worker_id is IGNORED (bay's worker wins)", owner == primary3["id"])

section("PHASE 1 · queue cannot pick a worker")
code, _ = call("POST", f"/api/v1/queue/{qa}/reassign", TOK, {"worker_id": temp_w["id"]})
check("reassign endpoint removed", code in (404, 405), f"HTTP {code}")
code, r = call("POST", f"/api/v1/queue/{qa}/change-bay", TOK, {"bay_id": B4})
_, q = call("GET", "/api/v1/queue", TOK)
owner = next((wid for wid, items in q["data"].items() for it in items if it["id"] == qa), None)
check("change-bay re-resolves worker (job follows bay)", code == 200 and owner == primary4["id"],
      f"now under {primary4['name']}")
code, r = call("POST", f"/api/v1/queue/{qa}/change-bay", TOK, {"bay_id": None})
check("change-bay rejects null bay (bay-first)", code in (400, 422))

section("PHASE 1 · temp-assignment validation")
today = date.today(); plus2 = today + timedelta(days=2)
code, r = call("POST", f"/api/v1/bays/{B3}/temp-assign", TOK,
               {"replacement_worker_id": temp_w["id"], "start_date": str(plus2), "end_date": str(today), "reason": "x"})
check("end < start → 400", code == 400)
_, me = call("GET", "/api/v1/auth/me", TOK)
code, r = call("POST", f"/api/v1/bays/{B3}/temp-assign", TOK,
               {"replacement_worker_id": me["data"]["id"], "start_date": str(today), "end_date": str(plus2), "reason": "x"})
check("non-worker (admin) as replacement → 400", code == 400, r.get("message"))
code, r = call("POST", f"/api/v1/bays/{B3}/temp-assign", TOK,
               {"replacement_worker_id": primary3["id"], "start_date": str(today), "end_date": str(plus2), "reason": "x"})
check("replacement == primary → 400", code == 400)
call("POST", f"/api/v1/bays/{B3}/revert-worker", TOK)   # clear any stale cover (robust to crashed prior runs)
code, _ = call("POST", f"/api/v1/bays/{B3}/temp-assign", TOK,
               {"replacement_worker_id": temp_w["id"], "start_date": str(today), "end_date": str(plus2), "reason": "VERIFY cover"})
check("valid temp-assign → 200", code == 200)
code, r = call("POST", f"/api/v1/bays/{B3}/temp-assign", TOK,
               {"replacement_worker_id": temp_w["id"], "start_date": str(today), "end_date": str(plus2), "reason": "dupe"})
check("overlapping temp → 409", code == 409)
_, d = call("GET", f"/api/v1/bays/{B3}/detail", TOK)
check("temp worker now resolves", d["data"]["worker"]["id"] == temp_w["id"] and d["data"]["worker"]["is_temp"])
code, r = call("POST", f"/api/v1/bays/{B3}/revert-worker", TOK)
_, d = call("GET", f"/api/v1/bays/{B3}/detail", TOK)
check("revert restores primary", code == 200 and d["data"]["worker"]["id"] == primary3["id"])

section("PHASE 1 · primary-worker role guard + global bay number")
code, r = call("PUT", f"/api/v1/bays/{B3}", TOK, {"primary_worker_id": me["data"]["id"]})
check("admin as primary worker → 400", code == 400, r.get("message"))
code, r = call("POST", "/api/v1/bays", TOK, {"bay_number": 3})
check("duplicate bay_number (global) → 409", code == 409)

section("PHASE 1 · maintenance / disabled guards (incl. force)")
call("POST", f"/api/v1/bays/{B4}/status", TOK, {"status": "maintenance"})
code, _ = call("POST", "/api/v1/jobs/manual", TOK, {"customer_name": "x", "bay_id": B4, "estimated_minutes": 5})
check("job on maintenance bay → 409", code == 409)
code, _ = call("POST", f"/api/v1/queue/{qa}/assign", TOK, {"bay_id": B4, "force": True})
check("assign(force) on maintenance bay → 409 (no bypass)", code == 409)
call("POST", f"/api/v1/bays/{B4}/status", TOK, {"status": "disabled"})
code, _ = call("POST", "/api/v1/jobs/manual", TOK, {"customer_name": "x", "bay_id": B4, "estimated_minutes": 5})
check("job on disabled bay → 409", code == 409)
call("POST", f"/api/v1/bays/{B4}/status", TOK, {"status": "available"})
code, _ = call("POST", f"/api/v1/queue/{qa}/assign", TOK, {"bay_id": B5, "force": True})
check("assign(force) on UNSTAFFED bay → 400 (no bypass)", code == 400)

section("PHASE 5 · full lifecycle + START-time re-resolution (live dashboard)")
code, r = call("POST", "/api/v1/jobs/manual", TOK,
               {"customer_name": "VERIFY Lifecycle", "vehicle_model": "Test Bike", "bay_id": B1, "estimated_minutes": 1})
qb = r["data"]["queue_id"]; job_id = r["data"]["job_card_id"]
code, r = call("POST", f"/api/v1/queue/{qb}/assign", TOK, {"bay_id": B1, "force": False})
ss_id = r["data"]["service_session_id"]
check("assigned → session created", code == 200 and ss_id.startswith("SS-"), ss_id)
cover = next(w for w in workers if w["id"] != primary1["id"])
call("POST", f"/api/v1/bays/{B1}/revert-worker", TOK)   # clear any stale cover first
code, _ = call("POST", f"/api/v1/bays/{B1}/temp-assign", TOK,
               {"replacement_worker_id": cover["id"], "start_date": str(today), "end_date": str(plus2), "reason": "VERIFY start-resolution"})
check("temp cover added AFTER assignment", code == 200, cover["name"])
code, _ = call("POST", f"/api/v1/bay-dashboard/{B1}/start", TOK)
check("START ok", code == 200)
_, dash = call("GET", "/api/v1/bay-dashboard", TOK)
row = next((s for s in dash["data"]["bays"] if s["session_id"] == ss_id), None)
check("live dashboard shows RE-RESOLVED worker (temp)", row and row["worker_id"] == cover["id"],
      f"dashboard worker = {row and row['worker_name']}")
check("live dashboard timer RUNNING", row and row["timer"]["current_status"] == "RUNNING")
time.sleep(2)
code, _ = call("POST", f"/api/v1/bay-dashboard/{B1}/pause", TOK); check("PAUSE ok", code == 200)
time.sleep(1)
code, _ = call("POST", f"/api/v1/bay-dashboard/{B1}/resume", TOK); check("RESUME ok", code == 200)
time.sleep(2)
code, _ = call("POST", f"/api/v1/bay-dashboard/{B1}/complete", TOK, {"actual_duration": None, "notes": ""})
check("COMPLETE ok", code == 200)
_, wc = call("GET", "/api/v1/reports/work-completion", TOK)
done = next((s for s in wc["data"] if s["session_id"] == ss_id), None)
check("completion log shows the temp worker", done and done["worker_id"] == cover["id"],
      f"completed by {done and done['worker_name']}")
_, opsr = call("GET", "/api/v1/bays/operations", TOK)
b1row = next(b for b in opsr["data"]["bays"] if b["bay_id"] == B1)
check("bay released after complete", b1row["current_job"] is None)
call("POST", f"/api/v1/bays/{B1}/revert-worker", TOK)   # restore primary

section("PHASE 5 · worker portal (own data)")
_, r = call("POST", "/api/v1/auth/login", body={"username": "worker", "password": "worker123"})
WTOK = r["access_token"]
c1, _ = call("GET", "/api/v1/worker/active", WTOK)
c2, _ = call("GET", "/api/v1/worker/queue", WTOK)
c3, _ = call("GET", "/api/v1/worker/history", WTOK)
check("worker portal endpoints 200", c1 == c2 == c3 == 200)
c4, _ = call("GET", "/api/v1/bays/operations", WTOK)
check("worker cannot read bay operations (403)", c4 == 403)

section("PHASE 5 · camera + timer mapping (bay resolves devices)")
_, d3 = call("GET", f"/api/v1/bays/{B3}/detail", TOK)
cam = d3["data"]["camera"]
check("camera resolves from registry", cam and cam["camera_id"] == "CAM-03", cam and cam["ip_address"])
# pick a guaranteed-UNPAIRED bay (some bays carry leftover registry timers)
_, tlist = call("GET", "/api/v1/timers", TOK)
unp = next(row for row in tlist["data"]["timers"] if not row.get("timer"))
UB, UBN = unp["bay_id"], unp["bay_number"]
code, r = call("POST", "/api/v1/timers", TOK, {"bay_id": UB, "timer_id": "TMR-VERIFY"})
tid = r["data"]["id"] if code in (200, 201) else None
_, d2 = call("GET", f"/api/v1/bays/{UB}/detail", TOK)
check("timer pairs → bay resolves it (esp32 offline until telemetry)",
      d2["data"]["timer"] and d2["data"]["timer"]["timer_id"] == "TMR-VERIFY" and d2["data"]["esp32"] == "offline")
check("timer topic derived from bay number", d2["data"]["timer"]["topic"] == f"bay/{UBN}/timer")
call("DELETE", f"/api/v1/timers/{tid}", TOK)
_, d2 = call("GET", f"/api/v1/bays/{UB}/detail", TOK)
check("unpair → esp32 unpaired", d2["data"]["esp32"] == "unpaired")

# ── cleanup: API-level ──
call("DELETE", f"/api/v1/queue/{qa}", TOK)

# ── cleanup: DB-level (lifecycle artifacts the API keeps for history) ──
section("cleanup")
import os
os.chdir("/Users/gopinathgt/bsms/backend")     # so app.config finds .env (Postgres URL)
sys.path.insert(0, "/Users/gopinathgt/bsms/backend")
import shutil
from app.database import SessionLocal
from app.models.session import ServiceSession, RecordingSession, CameraSession
from app.models.job import JobCard, JobQueue
from sqlalchemy import select as _sel
db = SessionLocal()
cleaned = []
try:
    # idempotent sweep: every artifact created by THIS suite is name-marked.
    # Deleted in explicit child→parent passes (own commit each) so FK order
    # never depends on unit-of-work batching.
    test_jobs = db.scalars(_sel(JobCard).where(
        JobCard.customer_name.like("VERIFY%") | JobCard.customer_name.like("BYPASS%"))).all()
    jids = [j.id for j in test_jobs]
    if jids:
        sss = db.scalars(_sel(ServiceSession).where(ServiceSession.job_card_id.in_(jids))).all()
        sids = [s.id for s in sss]
        if sids:
            for rec in db.scalars(_sel(RecordingSession).where(RecordingSession.service_session_id.in_(sids))).all():
                db.delete(rec)
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
finally:
    db.close()
for sid in cleaned:
    shutil.rmtree(f"/Users/gopinathgt/bsms/backend/media/recordings/{sid}", ignore_errors=True)
    shutil.rmtree(f"/Users/gopinathgt/bsms/backend/media/hls/{sid}", ignore_errors=True)
print(f"  cleaned: {len(test_jobs)} test job(s), sessions {cleaned}, media")

passed = sum(1 for _, ok_ in P if ok_)
print(f"\n{'='*52}\nRESULT: {passed}/{len(P)} checks passed "
      f"{'✅ ALL PASS' if passed == len(P) else '❌ FAILURES: ' + ', '.join(n for n, ok_ in P if not ok_)}\n{'='*52}")
sys.exit(0 if passed == len(P) else 1)
