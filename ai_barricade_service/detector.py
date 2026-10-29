"""BarricadeDetector — a thin, CPU-friendly wrapper around Ultralytics YOLO (Phase D).

Reuses ONLY the safe "load the model once, return plain Box dicts" pattern from the reference repo
(Thirumurugan240/Shelf_Detection_For_Retail_Shop); none of its Streamlit / SQLite / shelf logic.

It detects people + vehicles on an UPLOADED image (no RTSP, no live loop, no OCR here) and returns
simple detections. It is a SUGGESTER only — it never decides anything and never talks to the relay;
the BSMS backend remains the sole decision authority.

Graceful degradation: if Ultralytics / its model can't load in this environment (e.g. no torch wheel
for the running Python), the detector falls back to a deterministic MOCK that reads the image's
dominant colour — so the whole API contract + ingest workflow stay fully testable offline. The mock
is clearly flagged (`model_loaded=False`, `mock=True`) and never pretends to be a real model.
"""
import io
import logging
import os

log = logging.getLogger("barricade.detector")

# COCO ids we care about → the backend's object vocabulary (person | bike | car | unknown).
# 2-wheelers → bike, 4-wheelers+ → car, human → person. class_name keeps the exact COCO label.
_KEEP_COCO = {0: "person", 1: "bicycle", 2: "car", 3: "motorcycle", 5: "bus", 7: "truck"}
_MAPPED = {"person": "person", "bicycle": "bike", "motorcycle": "bike",
           "car": "car", "bus": "car", "truck": "car"}


def map_type(coco_name: str) -> str:
    """COCO label → backend object_type (person|bike|car). Anything else → 'unknown' (fail-safe)."""
    return _MAPPED.get((coco_name or "").lower(), "unknown")


def _default_model() -> str:
    return os.environ.get("AI_BARRICADE_MODEL", "yolov8n.pt")


def _default_conf() -> float:
    try:
        return float(os.environ.get("AI_BARRICADE_CONF", "0.45"))
    except ValueError:
        return 0.45


class BarricadeDetector:
    """Loads YOLO once (lazily) and detects person/bike/car on an image. Falls back to a mock."""

    def __init__(self, model_name: str | None = None, conf: float | None = None,
                 force_mock: bool | None = None):
        self.model_name = model_name or _default_model()
        self.conf = conf if conf is not None else _default_conf()
        self._model = None
        self._loaded = False
        self.mock = True
        self.device = "cpu"
        self._load_error = None
        if force_mock is None:
            force_mock = os.environ.get("AI_BARRICADE_FORCE_MOCK", "").lower() in ("1", "true", "yes")
        self._force_mock = force_mock
        self._ensure_loaded()

    # ── model lifecycle ────────────────────────────────────────────
    def _ensure_loaded(self) -> None:
        if self._loaded or self._force_mock:
            return
        try:
            from ultralytics import YOLO            # lazy: heavy import, optional dependency
            self._model = YOLO(self.model_name)
            try:
                import torch
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
            except Exception:
                self.device = "cpu"
            self._loaded = True
            self.mock = False
            log.info("barricade detector: loaded %s on %s", self.model_name, self.device)
        except Exception as e:                       # no ultralytics / no torch wheel / no model file
            self._load_error = f"{e.__class__.__name__}: {e}"
            self.mock = True
            log.warning("barricade detector: real model unavailable (%s) — using MOCK detector",
                        e.__class__.__name__)

    def health(self) -> dict:
        return {
            "ok": True,
            "model_loaded": bool(self._loaded),
            "model_name": self.model_name,
            "device": self.device,
            "mock": bool(self.mock),
            "conf": self.conf,
            "note": (None if self._loaded else
                     "Real YOLO model not loaded in this environment — mock detector active. "
                     "Install ai_barricade_service/requirements.txt in a torch-supported venv for real inference."),
        }

    # ── detection ──────────────────────────────────────────────────
    def detect(self, image_bytes: bytes, conf: float | None = None,
               keep: list[str] | None = None) -> dict:
        """Return {ok, detections[], best_detection, image_size, mock}. Detections are plain dicts
        with class_name, mapped_type, confidence and an int pixel box — never a filesystem path."""
        threshold = self.conf if conf is None else float(conf)
        keepset = set(keep) if keep else None
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            w, h = im.size
        except Exception as e:
            return {"ok": False, "error": f"Unreadable image ({e.__class__.__name__})",
                    "detections": [], "best_detection": None, "image_size": None, "mock": self.mock}

        dets = self._infer_real(im, threshold) if self._loaded else self._infer_mock(im, threshold)
        if keepset is not None:
            dets = [d for d in dets if d["mapped_type"] in keepset or d["class_name"] in keepset]
        dets.sort(key=lambda d: d["confidence"], reverse=True)
        best = self._best_actionable(dets)
        return {"ok": True, "detections": dets, "best_detection": best,
                "image_size": {"width": w, "height": h}, "mock": self.mock}

    @staticmethod
    def _best_actionable(dets: list[dict]) -> dict | None:
        """Highest-confidence detection whose mapped_type the backend can act on (person/bike/car)."""
        for d in dets:                               # dets already sorted desc by confidence
            if d["mapped_type"] in ("person", "bike", "car"):
                return d
        return dets[0] if dets else None

    def _infer_real(self, im, threshold: float) -> list[dict]:
        out = []
        try:
            results = self._model.predict(im, conf=threshold, verbose=False)
            names = self._model.names
            for r in results:
                for b in getattr(r, "boxes", []) or []:
                    cls_id = int(b.cls[0])
                    if cls_id not in _KEEP_COCO:
                        continue
                    conf = float(b.conf[0])
                    if conf < threshold:
                        continue
                    x1, y1, x2, y2 = (int(v) for v in b.xyxy[0].tolist())
                    cname = names.get(cls_id, _KEEP_COCO[cls_id]) if isinstance(names, dict) else _KEEP_COCO[cls_id]
                    out.append(self._box(cname, conf, x1, y1, x2, y2))
        except Exception:
            log.warning("barricade detector: real inference failed", exc_info=True)
        return out

    def _infer_mock(self, im, threshold: float) -> list[dict]:
        """Deterministic, image-dependent stand-in: the image's dominant colour picks the class
        (red→car, green→person, blue→bike, else→person). Emits a high-confidence primary plus a
        low-confidence secondary so threshold filtering is exercised. Never fabricates a real model."""
        w, h = im.size
        try:
            r, g, b = im.resize((1, 1)).getpixel((0, 0))[:3]
        except Exception:
            r, g, b = 0, 0, 0
        if r >= g and r >= b:
            primary = "car"
        elif g >= r and g >= b:
            primary = "person"
        elif b >= r and b >= g:
            primary = "motorcycle"
        else:
            primary = "person"
        dets = [self._box(primary, 0.90, int(w * 0.1), int(h * 0.1), int(w * 0.7), int(h * 0.9))]
        # a low-confidence secondary (person) so a caller can see conf-threshold filtering work
        dets.append(self._box("person", 0.30, int(w * 0.6), int(h * 0.3), int(w * 0.95), int(h * 0.95)))
        return [d for d in dets if d["confidence"] >= threshold]

    @staticmethod
    def _box(cname: str, conf: float, x1: int, y1: int, x2: int, y2: int) -> dict:
        return {
            "class_name": cname,
            "mapped_type": map_type(cname),
            "confidence": round(float(conf), 4),
            "box": {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)},
        }


_detector: BarricadeDetector | None = None


def get_detector() -> BarricadeDetector:
    """Process-wide singleton so the (heavy) model loads once."""
    global _detector
    if _detector is None:
        _detector = BarricadeDetector()
    return _detector
