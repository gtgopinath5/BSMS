"""WebSocket real-time push.

Each socket authenticates with a JWT passed as `?token=...` (browsers can't set
Authorization headers on WS), then pushes the relevant snapshot once per second.
This replaces HTTP polling for live data.

  /ws/bay-dashboard   admin/master   → full live bay dashboard
  /ws/worker          worker         → the worker's own active job (token = identity)
  /ws/queue           admin/master   → Job Assignment / Queue snapshot (grouped by worker)
  /ws/intake          admin/master   → Intake Evidence snapshot (worker-wise; branch from JWT)
  /ws/approvals       admin/master   → Customer Approvals change-signal (branch from JWT)
  /ws/barricade       admin/master   → AI Barricade live snapshot (branch from JWT)

Branch isolation is enforced from the JWT, never a client query param: an admin always sees
ONLY their own ``branch_id``; a master sees global. Payloads are summary-only — no media bytes,
no file paths, no public approval tokens.
"""
import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from jose import JWTError

from ..config import settings
from ..database import SessionLocal
from ..services import snapshots
from jose import jwt

router = APIRouter()

PUSH_INTERVAL = 1.0


def _auth(ws: WebSocket) -> dict | None:
    token = ws.query_params.get("token")
    if not token:
        return None
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None


async def _stream(ws: WebSocket, build, *, roles=None):
    """Accept, authorize, then push build(db) every second until disconnect."""
    await ws.accept()
    payload = _auth(ws)
    if not payload:
        await ws.close(code=4401)   # unauthorized
        return
    if roles and payload.get("role") not in roles:
        await ws.close(code=4403)   # forbidden
        return
    try:
        while True:
            db = SessionLocal()
            try:
                data = build(db, payload)
            finally:
                db.close()
            await ws.send_json({"data": data})
            await asyncio.sleep(PUSH_INTERVAL)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await ws.close()
        except Exception:
            pass


def _branch(payload: dict) -> str | None:
    """Branch scope for a stream, derived from the JWT (never a client param): a master sees
    global (None); every other role is confined to its own branch_id."""
    return None if payload.get("role") == "master_admin" else payload.get("branch_id")


@router.websocket("/bay-dashboard")
async def ws_bay_dashboard(ws: WebSocket):
    await _stream(ws, lambda db, p: snapshots.dashboard(db), roles={"admin", "master_admin"})


@router.websocket("/worker")
async def ws_worker(ws: WebSocket):
    await _stream(ws, lambda db, p: snapshots.worker_active(db, p["sub"]), roles={"worker"})


@router.websocket("/queue")
async def ws_queue(ws: WebSocket):
    await _stream(ws, lambda db, p: snapshots.queue(db, _branch(p)), roles={"admin", "master_admin"})


@router.websocket("/intake")
async def ws_intake(ws: WebSocket):
    await _stream(ws, lambda db, p: snapshots.intake(db, _branch(p)), roles={"admin", "master_admin"})


@router.websocket("/approvals")
async def ws_approvals(ws: WebSocket):
    await _stream(ws, lambda db, p: snapshots.approvals(db, _branch(p)), roles={"admin", "master_admin"})


@router.websocket("/barricade")
async def ws_barricade(ws: WebSocket):
    await _stream(ws, lambda db, p: snapshots.barricade(db, _branch(p)), roles={"admin", "master_admin"})
