"""AI Barricade detection service (Phase D) — a SEPARATE, CPU-friendly FastAPI process.

It is isolated from the main BSMS backend so YOLO inference never blocks the API. It runs detection
on an UPLOADED image (short video optional), and can forward a SUGGESTED detection to the backend's
Phase B ingest — which stays the sole decision authority. No RTSP, no live loop, no OCR, no relay.

Run (dev, mock ok):   uvicorn app:app --port 8811   (from ai_barricade_service/)
Config via env:
    BSMS_BACKEND_URL          default http://localhost:8000/api/v1
    BARRICADE_INTERNAL_TOKEN  internal ingest token (production path; kept server-side, never to UI)
    AI_BARRICADE_BEARER       admin/master JWT (test path, if no internal token)
    AI_BARRICADE_MODEL        default yolov8n.pt
    AI_BARRICADE_CONF         default 0.45
Secrets are read from the environment and NEVER logged or returned.
"""
import io
import logging
import os

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from detector import get_detector
import client as ingest_client
import ocr as plate_ocr
from stream_worker import StreamManager, StreamConfig
from state import get_state

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("barricade.service")

BACKEND_URL = os.environ.get("BSMS_BACKEND_URL", "http://localhost:8000/api/v1")
INTERNAL_TOKEN = os.environ.get("BARRICADE_INTERNAL_TOKEN") or None
BEARER = os.environ.get("AI_BARRICADE_BEARER") or None
CORS_ORIGINS = os.environ.get("AI_BARRICADE_CORS",
                              "http://localhost:7890,http://localhost:3000").split(",")

app = FastAPI(title="AI Barricade Detection Service", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in CORS_ORIGINS if o.strip()],
                   allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

# The stream manager is created but NOT started on import — start it explicitly via /streams/start.
_stream_cfg = StreamConfig(backend_url=BACKEND_URL, internal_token=INTERNAL_TOKEN, bearer=BEARER,
                           run_ocr=os.environ.get("AI_BARRICADE_RUN_OCR", "").lower() in ("1", "true", "yes", "on"))
_manager = StreamManager(_stream_cfg)


def _conf(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _truthy(v, default=False):
    if v in (None, ""):
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _ocr_for_best(best: dict | None, image_bytes: bytes, *, run_ocr: bool,
                  override: str | None, conf_override):
    """Run plate OCR ONLY for a vehicle (bike/car) best-detection; a person has no plate. Returns the
    OCR dict (or None). The detector suggests; OCR only reads; the backend still decides."""
    if not best or best.get("mapped_type") not in ("bike", "car"):
        return None
    if not run_ocr and override is None:
        return None
    return plate_ocr.resolve_plate(image_bytes, best.get("box"), run_ocr=run_ocr,
                                   vehicle_number_override=override,
                                   ocr_confidence_override=conf_override)


@app.get("/health")
def health():
    d = get_detector()
    return {**d.health(), "backend_url": BACKEND_URL, "ocr": plate_ocr.get_ocr().health(),
            "ingest_auth": "internal_token" if INTERNAL_TOKEN else ("bearer" if BEARER else "none")}


@app.get("/ready")
def ready():
    # The service is READY once it can answer (mock or real). Model availability is in /health.
    return JSONResponse(status_code=200, content={"ready": True, "mock": get_detector().mock})


@app.post("/detect/image")
async def detect_image(file: UploadFile = File(...), conf: str = Form(None), keep: str = Form(None),
                       run_ocr: str = Form(None),                    # opt-in plate read for vehicles
                       vehicle_number_override: str = Form(None),    # TEST only (bypasses/injects OCR)
                       ocr_confidence_override: str = Form(None)):   # TEST only
    data = await file.read()
    keep_list = [k.strip() for k in keep.split(",")] if keep else None
    result = get_detector().detect(data, conf=_conf(conf), keep=keep_list)
    ocr_res = _ocr_for_best(result.get("best_detection"), data,
                            run_ocr=_truthy(run_ocr, default=(vehicle_number_override is not None)),
                            override=vehicle_number_override, conf_override=_conf(ocr_confidence_override))
    if ocr_res is not None:                                          # flat fields for the UI + nested
        result["ocr"] = ocr_res
        result["plate_text"] = ocr_res.get("plate_text")
        result["normalized_plate"] = ocr_res.get("normalized_plate")
        result["ocr_confidence"] = ocr_res.get("ocr_confidence")
        result["ocr_mock"] = ocr_res.get("mock")
        result["ocr_engine"] = ocr_res.get("engine")
    return result


@app.post("/detect-and-ingest/image")
async def detect_and_ingest_image(
        file: UploadFile = File(...),
        branch_id: str = Form(...),
        direction: str = Form("entrance"),
        conf: str = Form(None),
        run_ocr: str = Form(None),                    # read a plate for a vehicle before ingest
        vehicle_number_raw: str = Form(None),         # legacy manual override (kept for back-compat)
        ocr_confidence: str = Form(None),             # legacy manual confidence
        vehicle_number_override: str = Form(None),    # TEST only (preferred name)
        ocr_confidence_override: str = Form(None)):   # TEST only
    data = await file.read()
    det = get_detector().detect(data, conf=_conf(conf))
    best = det.get("best_detection")
    if not best:
        return {"ok": True, "detection": det, "best_detection": None, "ocr": None,
                "ingest": {"ok": False, "skipped": True,
                           "reason": "No actionable person/bike/car detected — nothing suggested."}}
    override = vehicle_number_override if vehicle_number_override is not None else vehicle_number_raw
    conf_override = _conf(ocr_confidence_override) if ocr_confidence_override is not None else _conf(ocr_confidence)
    # OCR the vehicle (bike/car); a person carries no plate. Default: run OCR unless explicitly off.
    ocr_res = _ocr_for_best(best, data, run_ocr=_truthy(run_ocr, default=True),
                            override=override, conf_override=conf_override)
    plate = ocr_res.get("plate_text") if ocr_res else None          # may be None → backend pending
    ocr_c = ocr_res.get("ocr_confidence") if ocr_res else None
    ing = ingest_client.ingest(
        best, branch_id=branch_id, direction=direction, backend_url=BACKEND_URL,
        internal_token=INTERNAL_TOKEN, bearer=BEARER, source="detect_ingest",
        vehicle_number_raw=plate, ocr_confidence=ocr_c)
    return {"ok": True, "detection": det, "best_detection": best, "ocr": ocr_res, "ingest": ing}


@app.post("/detect/video")
async def detect_video(file: UploadFile = File(...), every_n: int = Form(15),
                       max_frames: int = Form(20), conf: str = Form(None)):
    """Short uploaded video: sample every Nth frame and detect. Needs OpenCV; if it isn't installed
    in this environment we report that honestly rather than crashing (RTSP/live loop is NOT here)."""
    try:
        import cv2  # noqa: F401
    except Exception:
        return {"ok": False, "supported": False,
                "reason": "OpenCV (opencv-python-headless) is not installed in this environment — "
                          "video frame sampling is unavailable. Install requirements.txt in a "
                          "torch/opencv-supported venv. (No RTSP / live loop in this phase.)"}
    import tempfile
    data = await file.read()
    det = get_detector()
    frames_out = []
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=True) as tf:
        tf.write(data)
        tf.flush()
        import cv2
        cap = cv2.VideoCapture(tf.name)
        idx = kept = 0
        while kept < max_frames:
            ok = cap.grab()
            if not ok:
                break
            if idx % max(1, int(every_n)) == 0:
                _, frame = cap.retrieve()
                ok2, buf = cv2.imencode(".jpg", frame)
                if ok2:
                    r = det.detect(buf.tobytes(), conf=_conf(conf))
                    frames_out.append({"frame_index": idx, "detections": r["detections"],
                                       "best_detection": r["best_detection"]})
                    kept += 1
            idx += 1
        cap.release()
    return {"ok": True, "supported": True, "frames_sampled": len(frames_out),
            "every_n": every_n, "frames": frames_out, "mock": det.mock}


# ════════════════════ RTSP stream workers (Phase E) ════════════════════
class StartBody(BaseModel):
    use_backend_config: bool = True
    branch_id: str | None = None
    direction: str | None = None
    sources: list[dict] | None = None       # explicit specs (dev/verifier): {branch_id,direction,source,...}
    vehicle_number_raw: str | None = None    # optional test override (pre-OCR); null in production
    run_ocr: bool | None = None              # read a plate per frame before ingest (else cfg default)


@app.get("/streams/status")
def streams_status():
    return {"ok": True, **get_state().status(), "backend_url": BACKEND_URL,
            "ingest_auth": "internal_token" if INTERNAL_TOKEN else ("bearer" if BEARER else "none")}


@app.post("/streams/start")
def streams_start(body: StartBody):
    st = _manager.start(sources=body.sources, use_backend_config=body.use_backend_config,
                        branch_id=body.branch_id, direction=body.direction,
                        overrides={"vehicle_number_raw": body.vehicle_number_raw,
                                   "run_ocr": body.run_ocr})
    return {"ok": True, **st}


@app.post("/streams/stop")
def streams_stop():
    return {"ok": True, **_manager.stop()}


@app.post("/streams/reload")
def streams_reload():
    return {"ok": True, **_manager.reload()}


@app.post("/streams/test-file")
async def streams_test_file(files: list[UploadFile] = File(...), branch_id: str = Form(...),
                            direction: str = Form("entrance"), conf: str = Form(None),
                            cooldown_seconds: int = Form(10), vehicle_number_raw: str = Form(None),
                            run_ocr: str = Form(None)):
    """Run the SAME stream pipeline over uploaded image frames (no RTSP camera needed) — the
    verifier + the admin 'Test file' button. Posts suggestions to the backend and returns a summary
    with the created event numbers. (A video needs OpenCV; this cv2-free path uses image frames.)"""
    frames = []
    for f in files:
        data = await f.read()
        # a video without OpenCV can't be decoded here — skip it honestly; images pass through
        if (f.filename or "").lower().endswith((".mp4", ".mov", ".avi", ".mkv")):
            continue
        frames.append(data)
    if not frames:
        return {"ok": False, "reason": "No decodable image frames (video needs OpenCV, not installed here)."}
    spec = {"branch_id": branch_id, "direction": direction, "camera_name": "test-file",
            "detection_threshold": _conf(conf), "cooldown_seconds": cooldown_seconds,
            "vehicle_number_raw": (vehicle_number_raw or None),
            "run_ocr": _truthy(run_ocr, default=None) if run_ocr is not None else None}
    return _manager.process_test_frames(frames, spec)
