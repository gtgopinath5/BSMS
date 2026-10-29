"""RTSP stream workers (Phase E) — the frame → YOLO → debounce → SUGGEST pipeline.

One worker thread per enabled camera (entrance / exit). Each connects to its source, samples frames
at ``frame_sample_fps``, runs the existing ``BarricadeDetector``, debounces repeated detections, and
POSTs a SUGGESTION to the backend via ``client.ingest``. It NEVER opens a barrier and has no relay
path — the backend stays the sole decision authority. Everything fails SAFE: a camera offline, a
detector error or a backend-ingest failure yields no open, just a logged status.

Not started on import; the service/CLI starts it explicitly.
"""
import logging
import threading
import time

import rtsp
from state import get_state

log = logging.getLogger("barricade.stream")

DEFAULT_COOLDOWN = 10
DEFAULT_FPS = 3


class StreamConfig:
    """Backend + auth for ingest (from env). Never logged."""
    def __init__(self, backend_url, internal_token=None, bearer=None, run_ocr=False):
        self.backend_url = backend_url
        self.internal_token = internal_token
        self.bearer = bearer
        self.run_ocr = bool(run_ocr)         # read a plate per vehicle frame before ingest (Phase F)


def _detector():
    from detector import get_detector
    return get_detector()


def process_frame(frame_bytes: bytes, spec: dict, cfg: StreamConfig) -> dict:
    """Run detection on one frame and, if a new object is seen (past cooldown), SUGGEST it to the
    backend. Returns a small result dict. Shared by the live worker loop AND the test-file pipeline.
    The backend decides the outcome — this never opens anything."""
    import client
    st = get_state()
    branch, direction = spec["branch_id"], spec["direction"]
    key = st.key(branch, direction)
    cooldown = spec.get("cooldown_seconds") or DEFAULT_COOLDOWN
    try:
        det = _detector().detect(frame_bytes, conf=spec.get("detection_threshold"))
    except Exception as e:                                   # detector error → fail safe, no open
        st.update(key, last_error=f"detector: {e.__class__.__name__}")
        return {"ok": False, "error": "detector_error"}
    best = det.get("best_detection")
    if not best:
        return {"ok": True, "detection": None}
    st.update(key, last_detection_at=True)
    if not st.should_ingest(branch, direction, best["mapped_type"], cooldown):
        return {"ok": True, "deduped": True, "best": best}
    # Phase F: read a plate for a vehicle (bike/car) before ingest when OCR is enabled for this stream.
    # A person has no plate. OCR only SUGGESTS a number + confidence; the backend still decides.
    run_ocr = spec.get("run_ocr")
    if run_ocr is None:
        run_ocr = getattr(cfg, "run_ocr", False)
    plate_raw, ocr_conf = spec.get("vehicle_number_raw"), None
    if run_ocr and best["mapped_type"] in ("bike", "car"):
        try:
            import ocr as plate_ocr
            ores = plate_ocr.resolve_plate(frame_bytes, best.get("box"), run_ocr=True,
                                           vehicle_number_override=spec.get("vehicle_number_raw"))
            if ores:
                plate_raw, ocr_conf = ores.get("plate_text"), ores.get("ocr_confidence")
        except Exception:                                   # OCR failure → fail safe (no plate)
            log.warning("stream OCR failed (non-fatal)", exc_info=True)
            plate_raw, ocr_conf = spec.get("vehicle_number_raw"), None
    res = client.ingest(best, branch_id=branch, direction=direction, backend_url=cfg.backend_url,
                        internal_token=cfg.internal_token, bearer=cfg.bearer,
                        vehicle_number_raw=plate_raw, ocr_confidence=ocr_conf,
                        camera_config_id=spec.get("camera_config_id"), source="rtsp_worker")
    dec = (res or {}).get("decision") or {}
    st.update(key, last_ingest_at=True, detections_sent_inc=1,
              last_decision=(dec.get("status") if res.get("ok") else f"ingest_failed_{res.get('status_code')}"))
    if not res.get("ok"):
        st.update(key, last_error=f"ingest failed ({res.get('status_code')})")
    return {"ok": True, "best": best, "ingest": res, "event_no": dec.get("event_no"),
            "status": dec.get("status")}


class CameraWorker(threading.Thread):
    def __init__(self, spec: dict, cfg: StreamConfig):
        super().__init__(daemon=True, name=f"bw-stream-{spec.get('direction')}")
        self.spec = spec
        self.cfg = cfg
        self._stop = threading.Event()
        self.fps = float(spec.get("frame_sample_fps") or DEFAULT_FPS)

    def stop(self):
        self._stop.set()

    def run(self):
        st = get_state()
        branch, direction = self.spec["branch_id"], self.spec["direction"]
        key = st.key(branch, direction)
        source = self.spec.get("source")
        safe = rtsp.strip_creds(source or "")                # NEVER log the credentialled URL
        backoff = 1.0
        while not self._stop.is_set():
            try:
                src = rtsp.open_source(source)
                st.update(key, connected=True, last_error=None)
                log.info("stream connected · branch=%s dir=%s cam=%s src=%s",
                         branch, direction, self.spec.get("camera_name"), safe)
                backoff = 1.0
            except Exception as e:                            # offline / unsupported → FAIL SAFE
                st.update(key, connected=False, last_error=str(e))
                log.warning("stream offline · branch=%s dir=%s cam=%s src=%s · %s",
                            branch, direction, self.spec.get("camera_name"), safe, e)
                if self._stop.wait(min(backoff, 8.0)):
                    break
                backoff = min(backoff * 2, 8.0)
                continue
            # frame loop
            while not self._stop.is_set():
                try:
                    frame = src.read()
                except Exception as e:
                    st.update(key, connected=False, last_error=f"read: {e.__class__.__name__}")
                    frame = None
                if frame is None:
                    st.update(key, connected=False, last_error="stream ended / unreadable")
                    break                                    # reconnect
                st.update(key, connected=True, last_frame_at=True)
                try:
                    process_frame(frame, self.spec, self.cfg)
                except Exception:
                    log.warning("frame processing error (non-fatal)", exc_info=True)
                if self._stop.wait(1.0 / max(0.5, self.fps)):
                    break
            src.close()
        st.update(key, connected=False)


class StreamManager:
    def __init__(self, cfg: StreamConfig):
        self.cfg = cfg
        self._workers: list[CameraWorker] = []
        self._last_start: dict | None = None
        self._lock = threading.RLock()

    # ── build worker specs ──
    def _spec_from_backend(self, cam: dict, overrides: dict) -> dict:
        return {
            "branch_id": cam.get("branch_id"), "direction": cam.get("direction"),
            "camera_config_id": cam.get("camera_config_id"), "camera_name": cam.get("camera_name"),
            "source": cam.get("rtsp_url"),               # credentialled URL (used, never logged)
            "detection_threshold": cam.get("detection_threshold"),
            "frame_sample_fps": cam.get("frame_sample_fps"),
            "cooldown_seconds": cam.get("cooldown_seconds"),
            "vehicle_number_raw": overrides.get("vehicle_number_raw"),
            "run_ocr": overrides.get("run_ocr"),
        }

    def _launch(self, specs: list[dict]):
        st = get_state()
        self.stop()
        st.clear()
        with self._lock:
            self._workers = []
            for s in specs:
                if not (s.get("branch_id") and s.get("direction")):
                    continue
                key = st.key(s["branch_id"], s["direction"])
                st.register(key, branch_id=s["branch_id"], direction=s["direction"],
                            camera_name=s.get("camera_name"),
                            source_display=rtsp.strip_creds(s.get("source") or ""),
                            fps=s.get("frame_sample_fps") or DEFAULT_FPS)
                w = CameraWorker(s, self.cfg)
                self._workers.append(w)
                w.start()
            st.set_running(bool(self._workers))
        return st.status()

    # ── public control ──
    def start(self, *, sources: list[dict] | None = None, use_backend_config: bool = True,
              branch_id: str | None = None, direction: str | None = None,
              overrides: dict | None = None) -> dict:
        overrides = overrides or {}
        specs: list[dict] = []
        if sources:                                     # explicit specs (dev/verifier)
            for s in sources:
                s = {**s}
                s.setdefault("vehicle_number_raw", overrides.get("vehicle_number_raw"))
                s.setdefault("run_ocr", overrides.get("run_ocr"))
                specs.append(s)
        elif use_backend_config:
            import client
            cams = client.fetch_config(self.cfg.backend_url, self.cfg.internal_token, self.cfg.bearer)
            for cam in cams:
                if branch_id and cam.get("branch_id") != branch_id:
                    continue
                if direction and cam.get("direction") != direction:
                    continue
                if not (cam.get("enabled") and cam.get("detection_enabled")):
                    continue
                specs.append(self._spec_from_backend(cam, overrides))
        self._last_start = {"sources": sources, "use_backend_config": use_backend_config,
                            "branch_id": branch_id, "direction": direction, "overrides": overrides}
        return self._launch(specs)

    def stop(self) -> dict:
        with self._lock:
            for w in self._workers:
                w.stop()
            for w in self._workers:
                w.join(timeout=3)
            self._workers = []
        get_state().set_running(False)
        return get_state().status()

    def reload(self) -> dict:
        if not self._last_start:
            return self.start(use_backend_config=True)
        return self.start(**self._last_start)

    def process_test_frames(self, frames: list[bytes], spec: dict) -> dict:
        """Run the SAME pipeline over a list of in-memory frames (no RTSP) — for the verifier and
        the admin 'Test file' button. Returns a summary incl. every backend event created."""
        st = get_state()
        key = st.key(spec["branch_id"], spec["direction"])
        st.register(key, branch_id=spec["branch_id"], direction=spec["direction"],
                    camera_name=spec.get("camera_name") or "test-file",
                    source_display="test-file", fps=spec.get("frame_sample_fps") or DEFAULT_FPS)
        st.update(key, connected=True)
        posted, deduped, events, statuses = 0, 0, [], []
        for fb in frames:
            st.update(key, last_frame_at=True)
            r = process_frame(fb, spec, self.cfg)
            if r.get("deduped"):
                deduped += 1
            elif r.get("event_no"):
                posted += 1
                events.append(r["event_no"])
                statuses.append(r.get("status"))
        st.update(key, connected=False)
        return {"ok": True, "frames_processed": len(frames), "ingests_posted": posted,
                "deduped_by_cooldown": deduped, "event_nos": events, "statuses": statuses}
