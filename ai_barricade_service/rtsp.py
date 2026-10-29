"""Frame sources for the stream worker (Phase E) + credential-safe helpers.

A source is a string:
  • an image path (.jpg/.png/.webp/.bmp)  → a static single-frame source (PIL only, no OpenCV) —
        represents one camera view; used for dev/verification without a real camera.
  • ``rtsp://…`` or a video file (.mp4/…)  → a live/video source via OpenCV. If OpenCV isn't
        installed in this environment the source raises ``SourceUnavailable`` and the worker
        fails SAFE (status shows the error; no frames, no ingest, no open).

Credential safety: ``strip_creds`` removes ``user:pass@`` from any RTSP URL for logging/status —
a full URL with a password is NEVER logged or put in an API response.
"""
import os
import re

_CRED_RE = re.compile(r"(rtsp://)[^@/\s]+@", re.IGNORECASE)
_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".bmp")


class SourceUnavailable(Exception):
    pass


def strip_creds(url: str | None) -> str:
    """rtsp://user:pass@host/path → rtsp://host/path (safe for logs + status)."""
    return _CRED_RE.sub(r"\1", url or "")


def _local_path(source: str) -> str:
    return source[7:] if source.startswith("file://") else source


def is_image(source: str) -> bool:
    return _local_path(source).lower().endswith(_IMAGE_EXT)


class ImageSource:
    """A static image read once and re-emitted each tick (no OpenCV needed)."""
    def __init__(self, source: str):
        path = _local_path(source)
        if not os.path.exists(path):
            raise SourceUnavailable(f"image not found: {os.path.basename(path)}")
        with open(path, "rb") as f:
            self._bytes = f.read()
        # validate it is a real image so a bad file fails at open (fail-safe)
        try:
            from PIL import Image
            import io
            Image.open(io.BytesIO(self._bytes)).verify()
        except Exception as e:
            raise SourceUnavailable(f"unreadable image ({e.__class__.__name__})")

    def read(self) -> bytes | None:
        return self._bytes

    def close(self):
        pass


class VideoSource:
    """RTSP stream / video file via OpenCV. Raises SourceUnavailable if OpenCV is missing or the
    stream can't be opened — the worker then fails safe."""
    def __init__(self, source: str):
        try:
            import cv2
        except Exception:
            raise SourceUnavailable("OpenCV (opencv-python-headless) not installed — RTSP/video "
                                    "streaming unavailable in this environment")
        self._cv2 = cv2
        self._cap = cv2.VideoCapture(_local_path(source))
        if not self._cap.isOpened():
            raise SourceUnavailable("could not open stream/video source")

    def read(self) -> bytes | None:
        ok, frame = self._cap.read()
        if not ok or frame is None:
            return None
        ok2, buf = self._cv2.imencode(".jpg", frame)
        return buf.tobytes() if ok2 else None

    def close(self):
        try:
            self._cap.release()
        except Exception:
            pass


def open_source(source: str):
    """Return an opened frame source for a spec string. Raises SourceUnavailable on failure."""
    if not source:
        raise SourceUnavailable("no RTSP/video/image source configured for this camera")
    return ImageSource(source) if is_image(source) else VideoSource(source)
