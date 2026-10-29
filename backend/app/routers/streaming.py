"""Streaming router — serves the live HLS feed behind signed, session-scoped URLs.

Mounted at /hls (NOT under /api/v1). The URL handed to the browser portals is
`/hls/secure/{session_id}/stream.m3u8?token=…&exp=…` (issued by streaming_service).
Both the playlist and its .ts segments are token-verified; the playlist is
rewritten on the fly so the player carries the token onto each segment request.
Raw RTSP is never exposed.
"""
from fastapi import APIRouter, HTTPException, Query, Response
from fastapi.responses import FileResponse

from ..services import streaming_service, recording_service

router = APIRouter()


@router.get("/secure/{session_id}/stream.m3u8")
def hls_playlist(session_id: str, token: str = Query(""), exp: str = Query("")):
    if not streaming_service.verify(session_id, token, exp):
        raise HTTPException(403, "Invalid or expired stream token")
    path = streaming_service.live_playlist(session_id)
    if not path.exists():
        # session not live (not started / paused / completed) → 404, no feed
        raise HTTPException(404, "No live stream for this session")
    # rewrite segment URIs so the player carries the token onto each .ts request
    q = f"?token={token}&exp={exp}"
    lines = []
    for line in path.read_text().splitlines():
        s = line.strip()
        if s and not s.startswith("#") and s.endswith(".ts"):
            line = f"{s}{q}"
        lines.append(line)
    return Response("\n".join(lines) + "\n",
                    media_type="application/vnd.apple.mpegurl",
                    headers={"Cache-Control": "no-store"})


@router.get("/secure/{session_id}/{segment}")
def hls_segment(session_id: str, segment: str, token: str = Query(""), exp: str = Query("")):
    if not streaming_service.verify(session_id, token, exp):
        raise HTTPException(403, "Invalid or expired stream token")
    # only .ts segments from this session's hls dir — no path traversal
    if not segment.endswith(".ts") or "/" in segment or ".." in segment:
        raise HTTPException(404, "Not found")
    seg = recording_service.live_hls_path(session_id).parent / segment
    if not seg.exists():
        raise HTTPException(404, "Segment expired")
    return FileResponse(str(seg), media_type="video/mp2t",
                        headers={"Cache-Control": "no-store"})
