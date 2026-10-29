"""Ingest client — the ONLY link from the detection service to the BSMS backend.

It POSTs a SUGGESTED detection to the existing Phase B endpoint ``/api/v1/barricade/ingest`` using
the backend's own security: an internal ``X-Barricade-Token`` (production) OR an admin/master Bearer
JWT (test). It never opens a barrier, never decides anything — the backend does. Secrets are never
logged. Uses stdlib ``urllib`` (falls back to ``requests`` if present) so it has no hard HTTP dep.
"""
import json
import logging
import urllib.error
import urllib.request

log = logging.getLogger("barricade.client")


def _auth_headers(internal_token: str | None, bearer: str | None) -> tuple[dict, str]:
    """Prefer the internal token (production path); else a Bearer JWT (test); else unauthenticated
    (which the backend correctly rejects — proving the endpoint is not public)."""
    if internal_token:
        return {"X-Barricade-Token": internal_token}, "internal_token"
    if bearer:
        return {"Authorization": "Bearer " + bearer}, "bearer"
    return {}, "none"


def ingest(detection: dict, *, branch_id: str, direction: str, backend_url: str,
           internal_token: str | None = None, bearer: str | None = None,
           vehicle_number_raw: str | None = None, ocr_confidence: float | None = None,
           camera_config_id: str | None = None, source: str | None = None,
           timeout: int = 8) -> dict:
    """POST one suggested detection to the backend and return the backend's decision.

    Returns {ok, status_code, auth_mode, decision, error?}. ``decision`` is the backend's event card
    (its status is the backend's call — pending_admin / auto_allowed / opened / …), NEVER ours.
    """
    payload = {
        "branch_id": branch_id,
        "direction": direction,
        "object_type": (detection or {}).get("mapped_type", "unknown"),
        "detection_confidence": (detection or {}).get("confidence"),
        "vehicle_number_raw": vehicle_number_raw,      # None until OCR exists (Phase F)
        "ocr_confidence": ocr_confidence,
        "camera_config_id": camera_config_id,
        "source": source or "rtsp_worker",
    }
    headers, auth_mode = _auth_headers(internal_token, bearer)
    headers["Content-Type"] = "application/json"
    url = backend_url.rstrip("/") + "/barricade/ingest"
    data = json.dumps(payload).encode()

    try:
        import requests                              # nicer if available; still no secret logging
        r = requests.post(url, data=data, headers=headers, timeout=timeout)
        status, body = r.status_code, _safe_json(r.text)
    except ImportError:
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status, body = resp.getcode(), _safe_json(resp.read().decode())
        except urllib.error.HTTPError as e:
            status, body = e.code, _safe_json(e.read().decode())
        except Exception as e:
            return {"ok": False, "status_code": None, "auth_mode": auth_mode,
                    "decision": None, "error": f"{e.__class__.__name__}: unreachable backend"}
    except Exception as e:                            # requests present but request failed
        return {"ok": False, "status_code": None, "auth_mode": auth_mode,
                "decision": None, "error": f"{e.__class__.__name__}"}

    ok = 200 <= (status or 0) < 300
    log.info("barricade ingest → %s (auth=%s)", status, auth_mode)   # status only; no secret
    return {"ok": ok, "status_code": status, "auth_mode": auth_mode,
            "decision": (body or {}).get("data") if ok else None,
            "message": (body or {}).get("message")}


def fetch_config(backend_url: str, internal_token: str | None = None, bearer: str | None = None,
                 timeout: int = 8) -> list[dict]:
    """GET the backend's INTERNAL barricade camera config (enabled cameras + RTSP components +
    credentials) using the internal token or an admin/master JWT. Returns [] on any failure — the
    worker then simply has no cameras to run (fail-safe). Never logs the response (it has creds)."""
    headers, _ = _auth_headers(internal_token, bearer)
    url = backend_url.rstrip("/") + "/barricade/internal/config"
    try:
        try:
            import requests
            r = requests.get(url, headers=headers, timeout=timeout)
            body = _safe_json(r.text) if r.status_code < 300 else None
        except ImportError:
            req = urllib.request.Request(url, headers=headers, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = _safe_json(resp.read().decode())
    except Exception as e:
        log.warning("barricade config fetch failed: %s", e.__class__.__name__)
        return []
    data = (body or {}).get("data")
    return data if isinstance(data, list) else []


def _safe_json(text: str):
    try:
        return json.loads(text)
    except Exception:
        return None
