"""Camera capture + HLS streaming via FFmpeg. Per-bay RTSP URLs come from env
(BAY_<n>_RTSP_URL). Imported lazily; all functions degrade to no-ops when
FFmpeg/cameras are absent so the rest of the system runs in dev.
"""
import os
import subprocess

_processes: dict[str, subprocess.Popen] = {}


def _rtsp(bay_id: str) -> str | None:
    return os.environ.get(f"BAY_{bay_id}_RTSP_URL")


def start_recording(bay_id: str, session_id: str):
    url = _rtsp(bay_id)
    if not url:
        return {"started": False, "reason": "no rtsp configured"}
    out = f"/tmp/rec_{session_id}.mp4"
    try:
        p = subprocess.Popen(["ffmpeg", "-y", "-i", url, "-c", "copy", out])
        _processes[session_id] = p
        return {"started": True, "path": out}
    except Exception as e:
        return {"started": False, "reason": str(e)}


def stop_recording(bay_id: str, session_id: str):
    p = _processes.pop(session_id, None)
    if p:
        p.terminate()
    out = f"/tmp/rec_{session_id}.mp4"
    video_url = None
    try:
        if os.path.exists(out):
            from ..utils import storage
            with open(out, "rb") as f:
                video_url = storage.upload_file("service-recordings", f"{session_id}.mp4",
                                                f.read(), "video/mp4")
    except Exception:
        pass
    return {"video_url": video_url}
