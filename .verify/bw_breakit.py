"""Adversarial 'attempt to break it' probe (Final Validation).
Tries to provoke real weaknesses against the live backend, then cleans up.
Findings feed FINAL_PRODUCTION_CHECKLIST.md.  Run with the backend venv.
"""
import json, sys, threading, urllib.request, urllib.error
BASE = "http://localhost:8000"

def call(method, path, token=None, body=None):
    h = {"Content-Type": "application/json"}
    if token: h["Authorization"] = "Bearer " + token
    d = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=d, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or "{}")
        except Exception: return e.code, {}

F = []
def find(name, ok, detail=""):
    F.append((name, bool(ok)))
    print(f"  [{'HOLDS' if ok else 'WEAK '}] {name}{' · ' + str(detail) if detail else ''}")

_, r = call("POST", "/api/v1/auth/login", body={"username": "admin", "password": "admin123"})
TOK = r["access_token"]
_, r = call("GET", "/api/v1/bays/operations", TOK)
bays = {b["bay_number"]: b for b in r["data"]["bays"]}
B1, B3 = bays[1]["bay_id"], bays[3]["bay_id"]

print("\n── ATTACK 1 · concurrent double-assign of the same queued job (double-booking) ──")
_, r = call("POST", "/api/v1/jobs/manual", TOK,
            {"customer_name": "BREAK Race", "vehicle_model": "Race", "bay_id": B1, "estimated_minutes": 5})
qid = r["data"]["queue_id"]; jid = r["data"]["job_card_id"]
results = {}
def assign(bay, key):
    results[key] = call("POST", f"/api/v1/queue/{qid}/assign", TOK, {"bay_id": bay, "force": False})
t1 = threading.Thread(target=assign, args=(B1, "a")); t2 = threading.Thread(target=assign, args=(B3, "b"))
t1.start(); t2.start(); t1.join(); t2.join()
codes = sorted([results["a"][0], results["b"][0]])
# count sessions actually created for this job
import os; os.chdir("/Users/gopinathgt/bsms/backend"); sys.path.insert(0, "/Users/gopinathgt/bsms/backend")
from app.database import SessionLocal
from app.models.session import ServiceSession
from sqlalchemy import select as _sel
db = SessionLocal()
nsess = len(db.scalars(_sel(ServiceSession).where(ServiceSession.job_card_id == jid)).all()); db.close()
find("concurrent double-assign is SAFE and GRACEFUL (1 session, loser 409 not 500)",
     nsess <= 1 and 200 in codes and 500 not in codes,
     f"sessions={nsess} · assign codes={codes}")

print("\n── ATTACK 2 · auth / role bypass ──")
c, _ = call("GET", "/api/v1/bays/operations", "garbage.token.here")
find("garbage JWT rejected (401)", c == 401, f"HTTP {c}")
c, _ = call("GET", "/api/v1/bays/operations", None)
find("missing JWT rejected (401/403)", c in (401, 403), f"HTTP {c}")
_, wr = call("POST", "/api/v1/auth/login", body={"username": "worker", "password": "worker123"})
WTOK = wr["access_token"]
esc = []
for ep in ("/api/v1/platform/system-health", "/api/v1/bays/operations", "/api/v1/master/branches",
           "/api/v1/storage"):
    c, _ = call("GET", ep, WTOK); esc.append((ep, c))
find("worker blocked from all admin/master endpoints (403)",
     all(c == 403 for _, c in esc), esc)

print("\n── ATTACK 3 · injection / malformed input ──")
c, r = call("GET", "/api/v1/platform/search?q=%27%20OR%201%3D1--", TOK)   # ' OR 1=1--
find("SQL-ish search returns 200, no 500/leak", c == 200, f"HTTP {c} total={r.get('data',{}).get('total')}")
c, r = call("POST", "/api/v1/jobs/manual", TOK,
            {"customer_name": "BREAK Neg", "bay_id": B1, "estimated_minutes": -50})
find("negative estimated_minutes does not 500", c in (200, 400, 422), f"HTTP {c}")
neg_q = r.get("data", {}).get("queue_id") if c == 200 else None
c, r = call("POST", "/api/v1/jobs/manual", TOK,
            {"customer_name": "BREAK Huge", "bay_id": B1, "estimated_minutes": 99999999})
find("absurd estimated_minutes does not 500", c in (200, 400, 422), f"HTTP {c}")
huge_q = r.get("data", {}).get("queue_id") if c == 200 else None
# wrong-typed field must be rejected by validation, not crash
c, _ = call("POST", "/api/v1/jobs/manual", TOK,
            {"customer_name": "BREAK Type", "bay_id": B1, "estimated_minutes": "not-a-number"})
find("wrong-typed estimated_minutes → 422 (not 500)", c in (400, 422), f"HTTP {c}")
# a minimal bay-first job (only bay_id) is VALID by design (all other fields optional)
c, r = call("POST", "/api/v1/jobs/manual", TOK, {"customer_name": "BREAK Minimal", "bay_id": B1})
find("minimal bay-first job accepted, no 500 (non-bay fields optional by design)", c == 200, f"HTTP {c}")
min_q = r.get("data", {}).get("queue_id") if c == 200 else None

print("\n── ATTACK 4 · lifecycle idempotency / illegal transitions ──")
# assign+start, then double-start and complete-twice
_, r = call("POST", "/api/v1/jobs/manual", TOK,
            {"customer_name": "BREAK Idem", "bay_id": B3, "estimated_minutes": 2})
iq = r["data"]["queue_id"]
call("POST", f"/api/v1/queue/{iq}/assign", TOK, {"bay_id": B3, "force": False})
c1, _ = call("POST", f"/api/v1/bay-dashboard/{B3}/start", TOK)
c2, _ = call("POST", f"/api/v1/bay-dashboard/{B3}/start", TOK)   # double start
find("double START does not crash (idempotent/4xx)", c1 == 200 and c2 in (200, 400, 409), f"{c1},{c2}")
cc1, _ = call("POST", f"/api/v1/bay-dashboard/{B3}/complete", TOK, {"actual_duration": None})
cc2, _ = call("POST", f"/api/v1/bay-dashboard/{B3}/complete", TOK, {"actual_duration": None})  # double complete
find("double COMPLETE does not crash", cc1 == 200 and cc2 in (200, 400, 404, 409), f"{cc1},{cc2}")

print("\n── ATTACK 5 · path traversal on recording playback ──")
for bad in ("..%2f..%2f..%2fetc%2fpasswd", "SS-does-not-exist"):
    c, _ = call("GET", f"/api/v1/recordings/{bad}", TOK)
    find(f"recording id '{bad[:20]}' not 500/leak", c in (400, 401, 403, 404, 422), f"HTTP {c}")

# ── cleanup ──
print("\n── cleanup ──")
for q in [qid, neg_q, huge_q, min_q, iq]:
    if q: call("DELETE", f"/api/v1/queue/{q}", TOK)
import shutil
from app.models.session import RecordingSession, CameraSession
from app.models.job import JobCard, JobQueue
db = SessionLocal(); cleaned = []
try:
    tj = db.scalars(_sel(JobCard).where(JobCard.customer_name.like("BREAK%"))).all()
    jids = [j.id for j in tj]
    if jids:
        sss = db.scalars(_sel(ServiceSession).where(ServiceSession.job_card_id.in_(jids))).all()
        sids = [s.id for s in sss]
        if sids:
            for x in db.scalars(_sel(RecordingSession).where(RecordingSession.service_session_id.in_(sids))).all(): db.delete(x)
            for x in db.scalars(_sel(CameraSession).where(CameraSession.service_session_id.in_(sids))).all(): db.delete(x)
            db.commit()
            for s in sss: cleaned.append(s.id); db.delete(s)
            db.commit()
        for x in db.scalars(_sel(JobQueue).where(JobQueue.job_card_id.in_(jids))).all(): db.delete(x)
        db.commit()
        for j in tj: db.delete(j)
        db.commit()
    # release any bay we left occupied (ATTACK 1 assigns without completing) so
    # this probe never strands a bay for the next suite.
    from app.models.bay import Bay
    from app.models.session import SessionStatus
    for b in db.scalars(_sel(Bay).where(Bay.status.in_(["running", "paused"]))).all():
        live = db.scalar(_sel(ServiceSession).where(
            ServiceSession.bay_id == b.id,
            ServiceSession.status.in_([SessionStatus.assigned, SessionStatus.running, SessionStatus.paused])))
        if not live:
            b.status = "available"
    db.commit()
finally:
    db.close()
for sid in cleaned:
    shutil.rmtree(f"/Users/gopinathgt/bsms/backend/media/recordings/{sid}", ignore_errors=True)
    shutil.rmtree(f"/Users/gopinathgt/bsms/backend/media/hls/{sid}", ignore_errors=True)
print(f"  cleaned {len(cleaned)} session(s)")

held = sum(1 for _, ok in F if ok)
print(f"\n{'='*56}\nBREAK-IT: {held}/{len(F)} defenses held "
      f"{'✅' if held == len(F) else '⚠️  WEAK: ' + ', '.join(n for n, ok in F if not ok)}\n{'='*56}")
sys.exit(0 if held == len(F) else 2)
