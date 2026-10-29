# AI Barricade Detection Service (Phase D)

A **separate, CPU-friendly** microservice that runs YOLO object detection on an **uploaded image**
(short video optional) and forwards a *suggested* detection to the BSMS backend. It is deliberately
**isolated** from the main FastAPI backend so heavy inference never blocks the API.

> **Safety contract (unchanged from Phase B):** this service only **suggests** — it detects
> person / bike / car and posts the suggestion to the backend. The **backend is the sole decision
> authority**; the simulation relay opens only if the backend authorizes it. This service has **no
> path to the relay** and makes **no decisions**.
>
> **Not in this phase:** RTSP streams, a live camera loop, OCR / number-plate extraction, real relay
> hardware. Those are Phases E–H.

## Architecture

```
uploaded image ─▶ detector.py (YOLO, load-once)         ── suggests
              ─▶ /detect-and-ingest/image
              ─▶ client.py  POST /api/v1/barricade/ingest   (X-Barricade-Token OR admin JWT)
              ─▶ BSMS backend = DECISION AUTHORITY  ── pending_admin / auto_allowed / opened / denied
              ─▶ simulation relay opens ONLY if the backend authorized it
```

- **`detector.py`** — `BarricadeDetector`: loads Ultralytics YOLO once, returns plain `Box` dicts
  (`class_name`, `mapped_type`, `confidence`, `box{x1,y1,x2,y2}`). COCO → backend vocab:
  person→`person`, bicycle/motorcycle→`bike`, car/bus/truck→`car`. **Graceful mock**: if
  Ultralytics/torch can't load (e.g. no wheel for the running Python), it falls back to a
  deterministic image-colour mock so the API + ingest are fully testable offline (`mock:true`,
  `model_loaded:false` — never faked).
- **`client.py`** — the only link to the backend. POSTs to `/api/v1/barricade/ingest` with the
  **internal token** (production) or an **admin/master Bearer JWT** (test). Never logs secrets.
- **`app.py`** — the FastAPI service.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | `{ok, model_loaded, model_name, device, mock, backend_url, ingest_auth}` |
| GET  | `/ready`  | 200 `{ready:true}` |
| POST | `/detect/image` | multipart `file` (+`conf`,`keep`) → `{detections[], best_detection, image_size, mock}` |
| POST | `/detect-and-ingest/image` | `file`,`branch_id`,`direction` (+`vehicle_number_raw`,`ocr_confidence` for pre-OCR testing) → runs YOLO, picks the best person/bike/car, posts the suggestion, returns detection **and** the backend's decision |
| POST | `/detect/video` | short `file` sampled every Nth frame (needs OpenCV; reports honestly if absent) |

## Run

```bash
# dedicated venv (real inference needs a torch-supported Python, e.g. 3.12):
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

BSMS_BACKEND_URL=http://localhost:8000/api/v1 \
BARRICADE_INTERNAL_TOKEN=<same value set as BARRICADE_INGEST_TOKEN on the backend> \
AI_BARRICADE_MODEL=yolov8n.pt AI_BARRICADE_CONF=0.45 \
uvicorn app:app --host 0.0.0.0 --port 8811
```

Mock mode (no ultralytics) runs with just `pillow fastapi uvicorn python-multipart` (which the BSMS
backend venv already has) — useful for wiring/verification without downloading a model.

## Configuration (environment only — never hard-coded, never sent to the frontend)

| Var | Default | Notes |
|---|---|---|
| `BSMS_BACKEND_URL` | `http://localhost:8000/api/v1` | backend API base |
| `BARRICADE_INTERNAL_TOKEN` | — | matches the backend's `BARRICADE_INGEST_TOKEN`; **production** ingest auth |
| `AI_BARRICADE_BEARER` | — | admin/master JWT; **test** ingest auth when no internal token |
| `AI_BARRICADE_MODEL` | `yolov8n.pt` | lightest COCO model |
| `AI_BARRICADE_CONF` | `0.45` | default confidence threshold |
| `AI_BARRICADE_FORCE_MOCK` | — | `1` to force the mock detector |
| `AI_BARRICADE_CORS` | `http://localhost:7890,http://localhost:3000` | admin upload panel origin |

Ingest is **never public**: with no internal token and no bearer the backend returns 401 — the
service never bypasses Phase B security. The internal token stays server-side and is never exposed
to the browser (the admin upload panel uploads the image to this service; this service authenticates
to the backend on its own).

## Phase E — RTSP stream workers

Optional background workers read frames from the **entrance/exit barricade cameras**, run the same
`BarricadeDetector`, **debounce** repeated detections, and POST suggestions to the backend. The
backend still decides; the workers have **no relay path**. **Off by default** — nothing auto-starts
on import; start it via the API or `run_stream_worker.py`.

- **`state.py`** — thread-safe live status + the ingest debounce map (per branch·direction·object).
- **`rtsp.py`** — frame sources: an **image path** (static frame, no OpenCV — dev/verification) or
  an **`rtsp://`/video** source (OpenCV; if OpenCV is absent it raises and the worker fails **safe**).
  `strip_creds()` removes `user:pass@` from any URL for logs/status — a full credentialled URL is
  **never** logged or returned by an API.
- **`stream_worker.py`** — `StreamManager` + one `CameraWorker` per camera: connect → sample at
  `frame_sample_fps` → detect → debounce (`cooldown_seconds`, default 10) → `client.ingest(source="rtsp_worker")`.
  Reconnects with backoff; a camera offline / detector error / ingest failure → **no open**, just status.
- **`run_stream_worker.py`** — CLI: fetch backend config, start workers, block until Ctrl-C.

**Config source of truth** = the backend. `GET /api/v1/barricade/internal/config` (internal
`X-Barricade-Token` **or** admin/master JWT; never public, never the frontend) returns the enabled
cameras with RTSP components + credentials + a ready `rtsp_url`. The public admin/master APIs keep
masking secrets.

CP Plus style URLs are built from `ip_address` / `rtsp_port` / `rtsp_path` / `username` / `password`.
For dev/verification without a real camera, a **local image path** works as a source
(`file:///tmp/frame.jpg` or a plain path).

### Stream control endpoints

| Method | Path | Purpose |
|---|---|---|
| GET  | `/streams/status` | worker running + per-camera {connected, last_frame/detection/ingest_at, last_error, fps, detections_sent} (masked; no creds) |
| POST | `/streams/start` | start workers (`use_backend_config`, or explicit `sources`, optional `branch_id`/`direction`, optional `vehicle_number_raw` test override) |
| POST | `/streams/stop` | stop workers safely |
| POST | `/streams/reload` | re-fetch backend config + restart |
| POST | `/streams/test-file` | run the pipeline over uploaded image frames (no RTSP) → summary + created event numbers |

Fail-safe: pre-OCR, a bike/car with no plate → backend `pending_admin` (never auto-opens); a person
follows the branch person policy; the relay opens only if the backend authorizes it.
