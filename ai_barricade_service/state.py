"""Thread-safe shared state for the RTSP stream workers (Phase E).

Holds the manager's running flag, a per-camera live status (masked — never a credential or a full
RTSP URL), and the ingest debounce map. One process-wide singleton via ``get_state()``.
"""
import threading
import time


def _now() -> float:
    return time.time()


def _iso(ts: float | None) -> str | None:
    return None if not ts else time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts))


class StreamState:
    def __init__(self):
        self._lock = threading.RLock()
        self.running = False
        self._cams: dict[str, dict] = {}
        self._debounce: dict[str, float] = {}       # (branch:direction:object_type) → last ingest ts

    @staticmethod
    def key(branch_id, direction) -> str:
        return f"{branch_id or '-'}:{direction or '-'}"

    def set_running(self, running: bool) -> None:
        with self._lock:
            self.running = bool(running)

    def register(self, key: str, *, branch_id, direction, camera_name=None, source_display=None,
                 fps=None) -> None:
        with self._lock:
            c = self._cams.setdefault(key, {
                "branch_id": branch_id, "direction": direction, "camera_name": camera_name,
                "source_display": source_display, "connected": False, "enabled": True,
                "last_frame_at": None, "last_detection_at": None, "last_ingest_at": None,
                "last_decision": None, "last_error": None, "fps": fps, "detections_sent": 0,
            })
            c.update({"branch_id": branch_id, "direction": direction, "camera_name": camera_name,
                      "source_display": source_display, "fps": fps})

    def update(self, key: str, **fields) -> None:
        with self._lock:
            c = self._cams.get(key)
            if c is None:
                return
            for k, v in fields.items():
                if k == "detections_sent_inc":
                    c["detections_sent"] = int(c.get("detections_sent") or 0) + int(v)
                elif k in ("last_frame_at", "last_detection_at", "last_ingest_at") and v is True:
                    c[k] = _now()
                else:
                    c[k] = v

    def clear(self) -> None:
        with self._lock:
            self._cams.clear()
            self._debounce.clear()

    def should_ingest(self, branch_id, direction, object_type, cooldown_seconds) -> bool:
        """Debounce: allow an ingest for (branch, direction, object_type) only if the cooldown window
        since the last one has elapsed. Prevents a burst of frames of the same object spamming the
        backend. Records the timestamp on allow."""
        k = f"{branch_id}:{direction}:{object_type}"
        cd = float(cooldown_seconds or 0)
        now = _now()
        with self._lock:
            last = self._debounce.get(k)
            if last is not None and cd > 0 and (now - last) < cd:
                return False
            self._debounce[k] = now
            return True

    def status(self) -> dict:
        with self._lock:
            cams = []
            for c in self._cams.values():
                cams.append({
                    "branch_id": c["branch_id"], "direction": c["direction"],
                    "camera_name": c["camera_name"], "source": c["source_display"],  # creds-stripped
                    "enabled": c["enabled"], "connected": c["connected"],
                    "last_frame_at": _iso(c["last_frame_at"]),
                    "last_detection_at": _iso(c["last_detection_at"]),
                    "last_ingest_at": _iso(c["last_ingest_at"]),
                    "last_decision": c["last_decision"], "last_error": c["last_error"],
                    "fps": c["fps"], "detections_sent": c["detections_sent"],
                })
            return {"running": self.running,
                    "cameras": sorted(cams, key=lambda x: (x["branch_id"] or "", x["direction"] or ""))}


_state: StreamState | None = None


def get_state() -> StreamState:
    global _state
    if _state is None:
        _state = StreamState()
    return _state
