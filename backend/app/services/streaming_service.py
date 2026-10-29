"""Streaming Service — secure, session-scoped access to the live HLS feed.

Browsers never receive the raw RTSP URL. While a session records, FFmpeg also
writes a low-latency HLS playlist; this service issues a signed, time-limited
token bound to the session id and verifies it before the router serves the
playlist / segments. (WebRTC is the future sub-second upgrade; HLS is the
broadly-compatible transport used today and what most NVRs serve to browsers.)
"""
import hashlib
import hmac
import time

from ..config import settings
from . import recording_service

TTL = 3600  # signed-url lifetime (seconds)


def _secret() -> bytes:
    return (settings.jwt_secret or "baywatch").encode()


def _sign(session_id: str, exp: int) -> str:
    return hmac.new(_secret(), f"{session_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def signed_url(session_id: str) -> str:
    """The secure live-feed URL handed to Master/Customer portals."""
    exp = int(time.time()) + TTL
    return f"/hls/secure/{session_id}/stream.m3u8?token={_sign(session_id, exp)}&exp={exp}"


def stream_token(session_id: str) -> dict:
    exp = int(time.time()) + TTL
    tok = _sign(session_id, exp)
    return {"token": tok, "exp": exp,
            "url": f"/hls/secure/{session_id}/stream.m3u8?token={tok}&exp={exp}"}


def verify(session_id: str, token: str | None, exp) -> bool:
    try:
        exp = int(exp)
    except (TypeError, ValueError):
        return False
    if not token or exp < int(time.time()):
        return False
    return hmac.compare_digest(token, _sign(session_id, exp))


def live_playlist(session_id: str):
    return recording_service.live_hls_path(session_id)


def is_live(session_id: str) -> bool:
    return recording_service.is_active(session_id) and recording_service.live_hls_path(session_id).exists()
