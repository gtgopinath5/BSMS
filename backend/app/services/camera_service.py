"""Camera Service — resolves a bay to its capture source + probes camera reachability.

The Camera Registry (`BayCamera`, managed by the admin Camera Connection page) is the
single source of truth for a bay's RTSP URL. This service consumes it, filling gaps from
the branch-wide CAPTURE DEFAULTS configured on the Integrations page (read through
``utils.integration_config`` — DB overrides env; env/defaults are the fallback). It NEVER
redefines the registry.

If a bay has no paired camera (or no RTSP URL), it returns a synthetic test source so the
recording pipeline still produces real files in development.

Security: credentials are injected into the probe/capture URL but NEVER logged or returned
in the clear — every surfaced URL / error message is run through :func:`_redact` first.
"""
import json
import os
import re
import shutil
import subprocess
from urllib.parse import urlsplit, urlunsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.camera_device import BayCamera
from ..utils import integration_config

_CRED_RE = re.compile(r"(rtsp://)[^@/\s]+@", re.IGNORECASE)


def _cfg() -> dict:
    return integration_config.get_config("camera")


def is_configured() -> bool:
    return integration_config.is_configured("camera")


def _redact(text: str | None) -> str:
    """Strip `user:pass@` from any rtsp URL in a string so creds never leak to logs/UI."""
    return _CRED_RE.sub(r"\1", text or "")


def _strip_creds(url: str) -> str:
    try:
        p = urlsplit(url)
        return urlunsplit(p._replace(netloc=p.netloc.split("@")[-1]))
    except Exception:
        return _redact(url)


def _inject_credentials(rtsp_url: str, username: str | None, password: str | None) -> str:
    """Put user:pass into the RTSP URL (rtsp://user:pass@host:port/path)."""
    if not rtsp_url or not username:
        return rtsp_url
    try:
        parts = urlsplit(rtsp_url)
        if "@" in parts.netloc:          # already has credentials
            return rtsp_url
        netloc = f"{username}:{password or ''}@{parts.netloc}"
        return urlunsplit(parts._replace(netloc=netloc))
    except Exception:
        return rtsp_url


def get_camera(db: Session, bay_id: str) -> BayCamera | None:
    return db.scalar(select(BayCamera).where(BayCamera.bay_id == bay_id))


def resolve_source(db: Session, bay_id: str) -> dict:
    """Return the capture-source spec the recording service understands:

        {"kind": "rtsp", "input": "<rtsp url with creds>", "camera_id": ...,
         "rtsp": "<safe url>", "rtsp_transport": "tcp|udp", "timeout": <s>}
        {"kind": "test", ...}   # dev fallback
    """
    cfg = _cfg()
    transport = (cfg.get("rtsp_transport") or "tcp").lower()
    if transport not in ("tcp", "udp"):
        transport = "tcp"
    cam = get_camera(db, bay_id)
    if cam and cam.rtsp_url:
        # per-bay creds win; fall back to the configured branch default login
        user = cam.username or (cfg.get("default_username") or None)
        pwd = cam.password if cam.username else (cfg.get("default_password") or None)
        return {
            "kind": "rtsp",
            "input": _inject_credentials(cam.rtsp_url, user, pwd),
            "camera_id": cam.camera_id,
            "rtsp": cam.rtsp_url,                 # safe (no creds) — logs/metadata only
            "rtsp_transport": transport,
            "timeout": cfg.get("connection_timeout"),
        }
    return {"kind": "test", "input": None,
            "camera_id": cam.camera_id if cam else None, "rtsp": None,
            "rtsp_transport": transport}


# ── connection test (real probe, honest failure) ───────────────────────────
def _probe_bin(cfg: dict) -> tuple[str | None, str | None]:
    """Return (kind, path): ('ffprobe', path) | ('ffmpeg', path) | (None, None)."""
    p = (cfg.get("ffmpeg_path") or "").strip()
    if p:
        cand = p.replace("ffmpeg", "ffprobe")
        if os.path.exists(cand):
            return "ffprobe", cand
        if os.path.exists(p):
            return "ffmpeg", p
    fp = shutil.which("ffprobe")
    if fp:
        return "ffprobe", fp
    fm = shutil.which("ffmpeg")
    if fm:
        return "ffmpeg", fm
    return None, None


def health() -> dict:
    """Probe the configured Test RTSP URL (or IP/port) with ffprobe/ffmpeg. Returns
    {configured, reachable, target, detail}. NEVER fakes success — an unreachable camera
    or a missing ffmpeg/ffprobe is reported honestly. Credentials are redacted from every
    returned/logged string."""
    cfg = _cfg()
    if not is_configured():
        return {"configured": False, "reachable": False,
                "detail": "Camera capture defaults are not enabled."}

    url = (cfg.get("test_rtsp_url") or "").strip()
    ip = (cfg.get("test_camera_ip") or "").strip()
    if not url and not ip:
        return {"configured": True, "reachable": False,
                "detail": "Set a Test RTSP URL or Test camera IP, then Save, to run a probe."}
    if not url:
        port = cfg.get("test_port") or 554
        path = cfg.get("default_rtsp_path") or "/"
        if not str(path).startswith("/"):
            path = "/" + str(path)
        url = f"rtsp://{ip}:{port}{path}"

    safe = _strip_creds(url)
    probe_url = _inject_credentials(url, cfg.get("default_username"), cfg.get("default_password"))

    kind, binpath = _probe_bin(cfg)
    if not binpath:
        return {"configured": True, "reachable": False, "target": safe,
                "detail": "ffprobe/ffmpeg not installed — cannot probe the camera."}

    transport = (cfg.get("rtsp_transport") or "tcp").lower()
    if transport not in ("tcp", "udp"):
        transport = "tcp"
    timeout = int(cfg.get("connection_timeout") or 10)
    us = str(timeout * 1_000_000)
    if kind == "ffprobe":
        cmd = [binpath, "-v", "error", "-rtsp_transport", transport, "-rw_timeout", us,
               "-i", probe_url, "-show_entries", "stream=codec_type,codec_name,width,height",
               "-of", "json"]
    else:  # ffmpeg fallback: read ~1s then null-mux
        cmd = [binpath, "-rtsp_transport", transport, "-rw_timeout", us, "-i", probe_url,
               "-t", "1", "-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        return {"configured": True, "reachable": False, "target": safe,
                "detail": f"Camera did not respond within {timeout}s — unreachable."}
    except Exception as e:
        return {"configured": True, "reachable": False, "target": safe,
                "detail": f"Probe failed: {e.__class__.__name__}"}

    if r.returncode == 0:
        desc = "stream OK"
        try:
            if kind == "ffprobe":
                streams = (json.loads(r.stdout or "{}").get("streams") or [])
                v = next((s for s in streams if s.get("codec_type") == "video"), None)
                if v:
                    desc = f"{v.get('codec_name', 'video')} {v.get('width', '?')}x{v.get('height', '?')}"
        except Exception:
            pass
        return {"configured": True, "reachable": True, "target": safe,
                "detail": f"Reachable · {desc}"}

    err = [ln for ln in (r.stderr or "").strip().splitlines() if ln.strip()]
    msg = _redact(err[-1]) if err else "Camera unreachable."
    return {"configured": True, "reachable": False, "target": safe, "detail": msg[:200]}


def probe_camera(db: Session, cam: BayCamera) -> dict:
    """Real per-bay RTSP probe (ffprobe/ffmpeg) for a SPECIFIC bay camera. Honest:
    an unreachable camera or a missing ffprobe/ffmpeg is reported reachable:false;
    resolution/fps are returned ONLY when actually reachable (never faked). The bay's
    credentials are injected into the probe URL but the raw password is NEVER returned
    — every surfaced string is credential-redacted. Returns
    {reachable, target, detail, resolution?, codec?, fps?}."""
    cfg = _cfg()
    url = (cam.rtsp_url or "").strip()
    if not url:                                   # build from ip:rtsp_port/rtsp_path
        ip = (cam.ip_address or "").strip()
        if not ip:
            return {"reachable": False, "target": None,
                    "detail": "No RTSP URL or IP address configured for this camera."}
        port = cam.rtsp_port or 554
        path = (cam.rtsp_path or cfg.get("default_rtsp_path") or "/")
        if not str(path).startswith("/"):
            path = "/" + str(path)
        url = f"rtsp://{ip}:{port}{path}"

    user = cam.username or (cfg.get("default_username") or None)
    pwd = cam.password if cam.username else (cfg.get("default_password") or None)
    safe = _strip_creds(url)                      # creds stripped for display/logs
    probe_url = _inject_credentials(url, user, pwd)

    kind, binpath = _probe_bin(cfg)
    if not binpath:
        return {"reachable": False, "target": safe,
                "detail": "ffprobe/ffmpeg not installed — cannot probe the camera."}

    transport = (cfg.get("rtsp_transport") or "tcp").lower()
    if transport not in ("tcp", "udp"):
        transport = "tcp"
    timeout = int(cfg.get("connection_timeout") or 10)
    us = str(timeout * 1_000_000)
    if kind == "ffprobe":
        cmd = [binpath, "-v", "error", "-rtsp_transport", transport, "-rw_timeout", us,
               "-i", probe_url, "-show_entries",
               "stream=codec_type,codec_name,width,height,avg_frame_rate", "-of", "json"]
    else:  # ffmpeg fallback: read ~1s then null-mux
        cmd = [binpath, "-rtsp_transport", transport, "-rw_timeout", us, "-i", probe_url,
               "-t", "1", "-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    except subprocess.TimeoutExpired:
        return {"reachable": False, "target": safe,
                "detail": f"Camera did not respond within {timeout}s — unreachable."}
    except Exception as e:
        return {"reachable": False, "target": safe,
                "detail": f"Probe failed: {e.__class__.__name__}"}

    if r.returncode == 0:
        resolution = codec = fps = None
        try:
            if kind == "ffprobe":
                streams = (json.loads(r.stdout or "{}").get("streams") or [])
                v = next((s for s in streams if s.get("codec_type") == "video"), None)
                if v:
                    codec = v.get("codec_name")
                    if v.get("width") and v.get("height"):
                        resolution = f"{v['width']}x{v['height']}"
                    afr = v.get("avg_frame_rate") or ""
                    if "/" in afr:
                        n, d = afr.split("/")
                        try:
                            if float(d):
                                fps = round(float(n) / float(d))
                        except Exception:
                            pass
        except Exception:
            pass
        desc = f"{codec} {resolution}" if (codec and resolution) else (resolution or "stream OK")
        return {"reachable": True, "target": safe, "detail": f"Reachable · {desc}",
                "resolution": resolution, "codec": codec, "fps": fps}

    err = [ln for ln in (r.stderr or "").strip().splitlines() if ln.strip()]
    msg = _redact(err[-1]) if err else "Camera unreachable."
    return {"reachable": False, "target": safe, "detail": msg[:200]}
