"""Persistent bay-timer engine — Redis is the single source of truth.

Every timer state is persisted to Redis on each change, so it survives a
backend restart, crash, Docker restart or redeploy. State is also
timestamp-anchored, so after a restart the remaining/overtime is simply
recalculated from the stored absolute times — no drift, nothing lost.

State (per bay) stored in Redis:
    service_session_id, job_card_id, worker_id, bay_id,
    estimated_duration, start_time, pause_time,
    accumulated_pause_duration, current_status

Statuses: READY · RUNNING · PAUSED · COMPLETED
  READY     — bay assigned, not started (no Redis key yet)
  RUNNING   — counting
  PAUSED    — frozen
  COMPLETED — removed from Redis, written permanently to PostgreSQL

Completed sessions are NOT kept in Redis (Redis holds active timers only).
"""
import json
import time
import logging

from ..config import settings

log = logging.getLogger("baywatch.timer")

KEY_PREFIX = "bay_timer:"
ACTIVE_SET = "bay_timer:active"

READY = "READY"
RUNNING = "RUNNING"
PAUSED = "PAUSED"
COMPLETED = "COMPLETED"

# ── connect to Redis (required for persistence) ────────────────────
try:
    import redis  # type: ignore
    _r = redis.Redis.from_url(settings.redis_url, decode_responses=True)
    _r.ping()
    _BACKEND = "redis"
    log.warning("[timer] Redis connected at %s — timers are PERSISTENT", settings.redis_url)
except Exception as e:  # pragma: no cover
    _r = None
    _BACKEND = "memory"
    log.error("[timer] Redis UNAVAILABLE (%s) — falling back to NON-PERSISTENT memory. "
              "Start Redis for production; timers will be lost on restart.", e)

_mem: dict[str, dict] = {}
_mem_active: set[str] = set()


def _key(bay_id: str) -> str:
    return KEY_PREFIX + str(bay_id)


def _read(bay_id: str) -> dict | None:
    if _BACKEND == "redis":
        raw = _r.get(_key(bay_id))
        return json.loads(raw) if raw else None
    return _mem.get(str(bay_id))


def _write(bay_id: str, state: dict) -> None:
    if _BACKEND == "redis":
        _r.set(_key(bay_id), json.dumps(state))
        _r.sadd(ACTIVE_SET, str(bay_id))
    else:
        _mem[str(bay_id)] = state
        _mem_active.add(str(bay_id))


def _clear(bay_id: str) -> None:
    if _BACKEND == "redis":
        _r.delete(_key(bay_id))
        _r.srem(ACTIVE_SET, str(bay_id))
    else:
        _mem.pop(str(bay_id), None)
        _mem_active.discard(str(bay_id))


def _active_ids() -> list[str]:
    if _BACKEND == "redis":
        return list(_r.smembers(ACTIVE_SET))
    return list(_mem_active)


# ── elapsed / remaining maths (timestamp-anchored) ─────────────────
def _elapsed(st: dict) -> float:
    start = st["start_time"]
    acc_pause = st.get("accumulated_pause_duration", 0.0)
    if st["current_status"] == PAUSED and st.get("pause_time"):
        return max(0.0, st["pause_time"] - start - acc_pause)
    return max(0.0, time.time() - start - acc_pause)


# ── control: persist on EVERY state change ─────────────────────────
def start(bay_id, estimated_seconds, session_id, meta=None) -> dict:
    meta = meta or {}
    state = {
        "current_status": RUNNING,
        "service_session_id": session_id,
        "job_card_id": meta.get("job_card_id"),
        "worker_id": meta.get("worker_id"),
        "bay_id": str(bay_id),
        "estimated_duration": int(estimated_seconds),
        "start_time": time.time(),
        "pause_time": None,
        "accumulated_pause_duration": 0.0,
        # handoff signals — ride through to the live dashboard (no schema change)
        "warnings": meta.get("warnings") or [],
        "estimate_source": meta.get("estimate_source"),
        "approved_cost": meta.get("approved_cost"),
    }
    _write(bay_id, state)
    log.info("[timer] START   bay=%s session=%s est=%ss", bay_id, session_id, int(estimated_seconds))
    return get_state(bay_id)


def pause(bay_id) -> dict:
    st = _read(bay_id)
    if st and st["current_status"] == RUNNING:
        st["pause_time"] = time.time()
        st["current_status"] = PAUSED
        _write(bay_id, st)
        log.info("[timer] PAUSE   bay=%s elapsed=%ds", bay_id, int(_elapsed(st)))
    return get_state(bay_id)


def resume(bay_id) -> dict:
    st = _read(bay_id)
    if st and st["current_status"] == PAUSED:
        if st.get("pause_time"):
            st["accumulated_pause_duration"] = st.get("accumulated_pause_duration", 0.0) + (time.time() - st["pause_time"])
        st["pause_time"] = None
        st["current_status"] = RUNNING
        _write(bay_id, st)
        log.info("[timer] RESUME  bay=%s paused_total=%ds", bay_id, int(st["accumulated_pause_duration"]))
    return get_state(bay_id)


def stop(bay_id) -> int:
    """COMPLETE — return total elapsed seconds and remove from Redis
    (the completed session is persisted to PostgreSQL by the caller)."""
    st = _read(bay_id)
    elapsed = int(_elapsed(st)) if st else 0
    if st:
        _clear(bay_id)
        log.info("[timer] COMPLETE bay=%s session=%s elapsed=%ds → removed from Redis (persisted to Postgres)",
                 bay_id, st.get("service_session_id"), elapsed)
    return elapsed


# ── reads ──────────────────────────────────────────────────────────
def elapsed_seconds(bay_id) -> int:
    st = _read(bay_id)
    return int(_elapsed(st)) if st else 0


def get_state(bay_id) -> dict:
    st = _read(bay_id)
    if not st:
        return {"status": READY, "current_status": READY, "remaining": 0,
                "elapsed": 0, "estimated_seconds": 0, "overtime": 0, "overtime_status": False}
    elapsed = int(_elapsed(st))
    est = st["estimated_duration"]
    overtime = max(0, elapsed - est)
    return {
        "status": st["current_status"],            # READY/RUNNING/PAUSED
        "current_status": st["current_status"],
        "service_session_id": st.get("service_session_id"),
        "job_card_id": st.get("job_card_id"),
        "worker_id": st.get("worker_id"),
        "bay_id": st.get("bay_id"),
        "estimated_seconds": est,
        "elapsed": elapsed,
        "remaining": est - elapsed,                # negative => overtime
        "overtime": overtime,
        "overtime_status": overtime > 0,
        "warnings": st.get("warnings") or [],
        "estimate_source": st.get("estimate_source"),
        "approved_cost": st.get("approved_cost"),
    }


# ── startup recovery ───────────────────────────────────────────────
def restore_all() -> int:
    """Reload all active timers from Redis, recalculate remaining + overtime,
    and log recovery. Called on backend startup."""
    ids = _active_ids()
    restored = 0
    for bay_id in ids:
        st = _read(bay_id)
        if not st:
            if _BACKEND == "redis":
                _r.srem(ACTIVE_SET, bay_id)   # prune stale index entry
            continue
        elapsed = int(_elapsed(st))
        est = st["estimated_duration"]
        remaining = est - elapsed
        overtime = max(0, elapsed - est)
        log.info("[timer][recovery] Timer restored      · bay=%s status=%s", bay_id, st["current_status"])
        log.info("[timer][recovery] Session restored    · session=%s worker=%s job=%s",
                 st.get("service_session_id"), st.get("worker_id"), st.get("job_card_id"))
        log.info("[timer][recovery] Remaining recalculated · elapsed=%ds remaining=%ds (est=%ds)",
                 elapsed, remaining, est)
        log.info("[timer][recovery] Overtime recalculated  · overtime=%ds (%s)",
                 overtime, "OVERTIME" if overtime > 0 else "within estimate")
        restored += 1
    log.warning("[timer][recovery] %d active timer(s) restored from Redis", restored)
    return restored


def active_ids() -> list[str]:
    """Public list of bay_ids that currently have an active (running/paused)
    timer. Used by the MQTT publisher to drive the physical ESP32 displays."""
    return _active_ids()


def active_count() -> int:
    return len(_active_ids())


def backend() -> str:
    return _BACKEND


def persistent() -> bool:
    return _BACKEND == "redis"
