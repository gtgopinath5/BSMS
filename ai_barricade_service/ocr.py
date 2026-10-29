"""OCR number-plate extraction (Phase F) — a SUGGESTION input for the AI Barricade service.

The detector (Phase D/E) says "there is a bike/car here"; this module then *attempts* to read the
plate off the vehicle crop (or full frame) and returns a plate + a confidence. It NEVER decides
anything and never touches the relay — the backend stays the sole decision authority. The plate +
``ocr_confidence`` are passed to the backend ingest, which normalises, matches, and decides
(low confidence / missing plate ⇒ ``pending_admin``, fail-safe).

Real engines are tried in order (EasyOCR → PaddleOCR → Tesseract). Because this environment's Python
often has no wheel for them, there is a graceful, deterministic **mock** so the whole pipeline stays
testable offline. The mock is ALWAYS flagged (``mock=True``, ``engine="mock"``) and — being unable to
truly read a plate — returns a deliberately LOW confidence that sits below the backend's OCR
threshold, so a pure-mock read can never spuriously authorise an open. It never pretends to be real.
"""
import hashlib
import io
import logging
import os
import re

log = logging.getLogger("barricade.ocr")

# Mirror the backend's normalization EXACTLY (utils/intake.normalize_bike_number):
# uppercase + strip every non-alphanumeric char. 'TN 07 BQ 5566' → 'TN07BQ5566'.
_NON_ALNUM = re.compile(r"[^A-Za-z0-9]")


def normalize_plate(raw: str | None) -> str:
    """Uppercase + strip every non-alphanumeric char (mirrors backend normalize_bike_number)."""
    return _NON_ALNUM.sub("", raw or "").upper()


def _force_mock() -> bool:
    return os.environ.get("AI_BARRICADE_OCR_FORCE_MOCK",
                          os.environ.get("AI_BARRICADE_FORCE_MOCK", "")).lower() in ("1", "true", "yes")


class PlateOCR:
    """Loads a real OCR engine once (lazily); falls back to a deterministic, clearly-flagged mock."""

    def __init__(self, force_mock: bool | None = None):
        self._engine = None
        self.engine_name = "mock"
        self.mock = True
        self._load_error = None
        self._force_mock = _force_mock() if force_mock is None else force_mock
        self._ensure_loaded()

    # ── engine lifecycle ────────────────────────────────────────────
    def _ensure_loaded(self) -> None:
        if self._force_mock:
            self._load_error = "forced mock (env)"
            return
        # EasyOCR
        try:
            import easyocr  # noqa: F401
            self._engine = easyocr.Reader(["en"], gpu=False)
            self.engine_name, self.mock = "easyocr", False
            log.info("barricade OCR: EasyOCR loaded"); return
        except Exception as e:
            self._load_error = f"easyocr: {e.__class__.__name__}"
        # PaddleOCR
        try:
            from paddleocr import PaddleOCR  # noqa: F401
            self._engine = PaddleOCR(use_angle_cls=False, lang="en", show_log=False)
            self.engine_name, self.mock = "paddleocr", False
            log.info("barricade OCR: PaddleOCR loaded"); return
        except Exception as e:
            self._load_error += f" | paddleocr: {e.__class__.__name__}"
        # Tesseract
        try:
            import pytesseract  # noqa: F401
            from PIL import Image  # noqa: F401
            self._engine = "tesseract"
            self.engine_name, self.mock = "tesseract", False
            log.info("barricade OCR: Tesseract (pytesseract) available"); return
        except Exception as e:
            self._load_error += f" | tesseract: {e.__class__.__name__}"
        self.mock = True
        log.warning("barricade OCR: no real engine available (%s) — using MOCK", self._load_error)

    def health(self) -> dict:
        return {
            "ok": True,
            "engine": self.engine_name,
            "mock": bool(self.mock),
            "note": (None if not self.mock else
                     "No real OCR engine (EasyOCR/PaddleOCR/Tesseract) in this environment — mock "
                     "plate reader active (low confidence, never authorises). Install one in a "
                     "supported venv for real plate reading."),
        }

    # ── reading ─────────────────────────────────────────────────────
    def read_plate(self, image_bytes: bytes, box: dict | None = None) -> dict:
        """Read a plate from the image (cropped to ``box`` when given). Returns a plain dict:
        plate_text, normalized_plate, ocr_confidence, engine, mock, crop{...}, note. Never raises;
        never returns a filesystem path. A failed/empty read yields a null plate (→ backend pending)."""
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        except Exception as e:
            return self._out(None, None, engine=self.engine_name, mock=self.mock, box=box,
                             note=f"unreadable image ({e.__class__.__name__})")
        crop, cbox = self._crop(im, box)
        if self.mock:
            text, conf = self._mock_read(image_bytes, cbox)
        else:
            text, conf = self._real_read(crop)
        return self._out(text, conf, engine=self.engine_name, mock=self.mock, box=cbox,
                         img_size={"width": im.size[0], "height": im.size[1]})

    @staticmethod
    def _crop(im, box):
        if not box:
            return im, None
        try:
            x1, y1, x2, y2 = int(box["x1"]), int(box["y1"]), int(box["x2"]), int(box["y2"])
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(im.size[0], x2), min(im.size[1], y2)
            if x2 > x1 and y2 > y1:
                return im.crop((x1, y1, x2, y2)), {"x1": x1, "y1": y1, "x2": x2, "y2": y2}
        except Exception:
            pass
        return im, None

    def _real_read(self, crop):
        """Best-effort real read. Returns (plate_text|None, confidence|None). Any failure → (None, None)
        so the backend safely falls to pending_admin. (Runs only when a real engine actually loaded.)"""
        try:
            candidates = []  # (text, conf)
            if self.engine_name == "easyocr":
                import numpy as np
                for _, txt, conf in self._engine.readtext(np.array(crop)):
                    candidates.append((txt, float(conf)))
            elif self.engine_name == "paddleocr":
                import numpy as np
                res = self._engine.ocr(np.array(crop), cls=False) or []
                for line in res:
                    for _, (txt, conf) in (line or []):
                        candidates.append((txt, float(conf)))
            elif self.engine_name == "tesseract":
                import pytesseract
                data = pytesseract.image_to_data(crop, output_type=pytesseract.Output.DICT)
                for txt, cf in zip(data.get("text", []), data.get("conf", [])):
                    try:
                        c = float(cf)
                    except (TypeError, ValueError):
                        c = -1.0
                    if txt and txt.strip() and c >= 0:
                        candidates.append((txt, c / 100.0))
            # keep tokens that look like a plate (>=5 alphanumerics), highest confidence wins
            best = None
            for txt, conf in candidates:
                if len(normalize_plate(txt)) >= 5 and (best is None or conf > best[1]):
                    best = (txt, conf)
            if best:
                return best[0], round(float(best[1]), 4)
        except Exception:
            log.warning("barricade OCR: real read failed", exc_info=True)
        return None, None

    @staticmethod
    def _mock_read(image_bytes: bytes, box) -> tuple[str, float]:
        """Deterministic synthetic plate from the image bytes (+box). Confidence is deliberately LOW
        (0.30–0.55, below the backend's 0.60 OCR threshold) so a mock read never authorises — honest."""
        h = hashlib.sha1(image_bytes + repr(box).encode()).hexdigest()
        L = "ABCDEFGHJKLMNPQRSTUVWXYZ"
        D = "0123456789"
        pick = lambda seq, n, off: "".join(seq[int(h[off + i * 2:off + i * 2 + 2] or "0", 16) % len(seq)] for i in range(n))
        plate = "MK" + pick(D, 2, 0) + pick(L, 2, 6) + pick(D, 4, 12)   # e.g. MK04ZZ1234 (synthetic)
        conf = round(0.30 + (int(h[30:32], 16) / 255.0) * 0.25, 4)      # 0.30 … <0.55
        return plate, conf

    @staticmethod
    def _out(text, conf, *, engine, mock, box=None, img_size=None, note=None) -> dict:
        text = (text or "").strip() or None
        return {
            "plate_text": text,
            "normalized_plate": (normalize_plate(text) or None) if text else None,
            "ocr_confidence": (round(float(conf), 4) if conf is not None else None),
            "engine": engine,
            "mock": bool(mock),
            "overridden": False,
            "crop": {"box": box, "used_full_frame": box is None},
            "image_size": img_size,
            "note": note,
        }


def resolve_plate(image_bytes: bytes | None, box: dict | None = None, *, run_ocr: bool = True,
                  vehicle_number_override: str | None = None,
                  ocr_confidence_override: float | None = None) -> dict | None:
    """Centralised plate resolution used by BOTH the endpoint and the RTSP worker.

    Precedence: an explicit TEST override wins; else (if ``run_ocr``) a real/mock read; else None.
    Overrides are ALWAYS flagged ``overridden=True`` (and ``mock=True`` — an injected value is not a
    real read). An empty-string override means "simulate a missing plate" (→ backend pending)."""
    if vehicle_number_override is not None:
        raw = vehicle_number_override.strip()
        if raw == "":
            return {"plate_text": None, "normalized_plate": None,
                    "ocr_confidence": ocr_confidence_override, "engine": "override", "mock": True,
                    "overridden": True, "crop": {"box": box, "used_full_frame": box is None},
                    "image_size": None, "note": "test override: simulated missing plate"}
        return {"plate_text": raw, "normalized_plate": normalize_plate(raw) or None,
                "ocr_confidence": (float(ocr_confidence_override) if ocr_confidence_override is not None else 0.99),
                "engine": "override", "mock": True, "overridden": True,
                "crop": {"box": box, "used_full_frame": box is None}, "image_size": None,
                "note": "test override plate"}
    if not run_ocr or image_bytes is None:
        return None
    res = get_ocr().read_plate(image_bytes, box)
    if ocr_confidence_override is not None:
        res = {**res, "ocr_confidence": float(ocr_confidence_override), "overridden": True,
               "note": (res.get("note") or "") + " | confidence overridden (test)"}
    return res


_ocr: PlateOCR | None = None


def get_ocr() -> PlateOCR:
    """Process-wide singleton so a (heavy) OCR engine loads once."""
    global _ocr
    if _ocr is None:
        _ocr = PlateOCR()
    return _ocr
