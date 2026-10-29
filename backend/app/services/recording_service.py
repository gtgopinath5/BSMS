"""Recording Service — real FFmpeg capture, one pipeline per service session.

Lifecycle (driven by the workflow engine on admin START/PAUSE/RESUME/COMPLETE):

    START   → spawn FFmpeg: capture the bay camera's RTSP → seg_000.ts  (+ live HLS)
    PAUSE   → stop the current segment process
    RESUME  → spawn FFmpeg again → seg_001.ts, seg_002.ts …  (+ fresh HLS)
    COMPLETE→ stop, concat seg_*.ts → video.mp4, probe duration, finalise metadata

Why segmented .ts: a service can be paused/resumed many times, and MPEG-TS is
safe to cut at any byte (no moov atom to corrupt), so a killed segment is always
playable. The segments are concatenated into a single MP4 only at COMPLETE.

A short-latency HLS playlist is produced WHILE recording so the browser portals
(Master monitoring, Customer live view) can watch — served behind signed URLs by
`streaming_service` (raw RTSP is never exposed).

No Celery dependency: FFmpeg runs as a tracked child process. State is persisted
per session so orphans can be reaped after a backend restart. If FFmpeg is not
installed the service degrades gracefully — the RecordingSession metadata is
still tracked, but no media file is produced (status = "unavailable").
"""
import json
import logging
import os
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

log = logging.getLogger("baywatch.recording")

MEDIA_ROOT = Path(os.environ.get("BW_MEDIA_ROOT") or (Path(__file__).resolve().parents[2] / "media"))
REC_ROOT = MEDIA_ROOT / "recordings"
HLS_ROOT = MEDIA_ROOT / "hls"

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
HAS_FFMPEG = FFMPEG is not None

# in-memory registry: session_id -> {"proc": Popen|None, "segment": int, "source": dict}
_active: dict[str, dict] = {}


# ── paths / state ──────────────────────────────────────────────────
def _sdir(session_id: str) -> Path:
    return REC_ROOT / session_id


def _hls_dir(session_id: str) -> Path:
    return HLS_ROOT / session_id


def _state_path(session_id: str) -> Path:
    return _sdir(session_id) / "state.json"


def _read_state(session_id: str) -> dict:
    try:
        return json.loads(_state_path(session_id).read_text())
    except Exception:
        return {}


def _write_state(session_id: str, **kw) -> None:
    st = _read_state(session_id)
    st.update(kw)
    try:
        _state_path(session_id).write_text(json.dumps(st, default=str, indent=2))
    except Exception:
        log.exception("recording: could not persist state for %s", session_id)


def live_hls_path(session_id: str) -> Path:
    return _hls_dir(session_id) / "index.m3u8"


def is_active(session_id: str) -> bool:
    a = _active.get(session_id)
    return bool(a and a.get("proc") and a["proc"].poll() is None)


# ── ffmpeg command builders ────────────────────────────────────────
def _input_args(source: dict) -> list[str]:
    if source.get("kind") == "rtsp" and source.get("input"):
        # a real camera streams in real time already. Transport comes from the
        # camera capture defaults (Integrations → Camera); defaults to tcp.
        transport = (source.get("rtsp_transport") or "tcp").lower()
        if transport not in ("tcp", "udp"):
            transport = "tcp"
        return ["-rtsp_transport", transport, "-i", source["input"]]
    # dev fallback: a real (synthetic) source. `-re` paces it at native frame
    # rate so the recording duration matches wall-clock, exactly like a camera.
    return ["-re", "-f", "lavfi", "-i", "testsrc=size=960x540:rate=15"]


def _segment_cmd(source: dict, seg_path: Path, hls_dir: Path) -> list[str]:
    base = [FFMPEG, "-loglevel", "warning", "-y", *_input_args(source)]
    if source.get("kind") == "rtsp" and source.get("input"):
        # copy codec — no transcode, low CPU; both outputs are H264/TS
        rec = ["-an", "-c:v", "copy", "-f", "mpegts", str(seg_path)]
        hls = ["-an", "-c:v", "copy", "-f", "hls", "-hls_time", "2", "-hls_list_size", "5",
               "-hls_flags", "delete_segments+omit_endlist",
               "-hls_segment_filename", str(hls_dir / "live_%03d.ts"), str(hls_dir / "index.m3u8")]
    else:
        enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "30"]
        rec = ["-an", *enc, "-f", "mpegts", str(seg_path)]
        hls = ["-an", *enc, "-f", "hls", "-hls_time", "1", "-hls_list_size", "3",
               "-hls_flags", "delete_segments+omit_endlist",
               "-hls_segment_filename", str(hls_dir / "live_%03d.ts"), str(hls_dir / "index.m3u8")]
    return base + rec + hls


def _spawn_segment(session_id: str, source: dict, index: int) -> subprocess.Popen | None:
    sdir = _sdir(session_id)
    hls_dir = _hls_dir(session_id)
    sdir.mkdir(parents=True, exist_ok=True)
    hls_dir.mkdir(parents=True, exist_ok=True)
    seg_path = sdir / f"seg_{index:03d}.ts"
    cmd = _segment_cmd(source, seg_path, hls_dir)
    logf = open(sdir / "ffmpeg.log", "ab")
    try:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=logf)
    except Exception:
        log.exception("recording: failed to spawn ffmpeg for %s", session_id)
        return None
    segs = _read_state(session_id).get("segments", [])
    segs.append(seg_path.name)
    _write_state(session_id, status="recording", segment_index=index, segments=segs, pid=proc.pid)
    log.info("recording: %s segment %d started (pid=%s, kind=%s)", session_id, index, proc.pid, source.get("kind"))
    return proc


def _guard_rtsp(session_id: str, source: dict, index: int, proc: subprocess.Popen | None) -> None:
    """Non-blocking watchdog: an RTSP open failure happens within ~1s. If the
    capture process dies without producing its segment, fall back to the dev test
    source (clearly logged) so development works without real hardware. In
    production a reachable camera never dies this fast, so the fallback is inert.
    START returns immediately; this runs in a short daemon thread."""
    if not proc or source.get("kind") != "rtsp":
        return

    def _watch():
        time.sleep(2.0)
        seg = _sdir(session_id) / f"seg_{index:03d}.ts"
        if proc.poll() is not None and (not seg.exists() or seg.stat().st_size == 0):
            if _read_state(session_id).get("status") != "recording":
                return
            log.warning("recording: RTSP unreachable for %s — dev fallback to test source", session_id)
            fb = _spawn_segment(session_id, {"kind": "test", "camera_id": source.get("camera_id")}, index)
            if session_id in _active:
                _active[session_id]["proc"] = fb
                _active[session_id]["source"] = {"kind": "test", "camera_id": source.get("camera_id")}

    threading.Thread(target=_watch, name=f"rec-guard-{session_id}", daemon=True).start()


def _terminate(proc: subprocess.Popen | None) -> None:
    """Ask FFmpeg to finalise ('q' on stdin), then escalate to SIGINT/kill."""
    if not proc or proc.poll() is not None:
        return
    try:
        proc.stdin.write(b"q")
        proc.stdin.flush()
    except Exception:
        pass
    try:
        proc.wait(timeout=4)
        return
    except Exception:
        pass
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        try:
            proc.send_signal(sig)
            proc.wait(timeout=3)
            return
        except Exception:
            continue


# ── public lifecycle API ───────────────────────────────────────────
def start(meta: dict) -> dict:
    """meta: {session_id, bay_id, source, recording_id, job_card_number,
              worker_name, customer_name, vehicle_number, camera_id}"""
    session_id = meta["session_id"]
    source = meta.get("source") or {"kind": "test"}
    sdir = _sdir(session_id)
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / "metadata.json").write_text(json.dumps({
        "session_id": session_id, "recording_id": meta.get("recording_id"),
        "job_card_number": meta.get("job_card_number"), "worker_name": meta.get("worker_name"),
        "customer_name": meta.get("customer_name"), "vehicle_number": meta.get("vehicle_number"),
        "bay_id": meta.get("bay_id"), "camera_id": source.get("camera_id"),
        "rtsp": source.get("rtsp"), "source_kind": source.get("kind"),
        "started_at": time.time(),
    }, indent=2, default=str))

    if not HAS_FFMPEG:
        _write_state(session_id, status="unavailable", segments=[], source=source.get("kind"))
        log.warning("recording: FFmpeg not installed — %s tracked as metadata only", session_id)
        return {"status": "unavailable", "reason": "ffmpeg-not-installed"}

    _write_state(session_id, status="recording", segments=[], source=source.get("kind"), started_at=time.time())
    proc = _spawn_segment(session_id, source, 0)
    _active[session_id] = {"proc": proc, "segment": 0, "source": source}
    _guard_rtsp(session_id, source, 0, proc)
    return {"status": "recording" if proc else "error", "hls": f"/hls/secure/{session_id}/stream.m3u8"}


def pause(session_id: str) -> dict:
    a = _active.get(session_id)
    if a:
        _terminate(a.get("proc"))
        a["proc"] = None
    _write_state(session_id, status="paused")
    log.info("recording: %s paused", session_id)
    return {"status": "paused"}


def resume(session_id: str, source: dict | None = None) -> dict:
    a = _active.get(session_id)
    if not HAS_FFMPEG:
        return {"status": "unavailable"}
    src = source or (a or {}).get("source") or {"kind": _read_state(session_id).get("source", "test")}
    next_idx = (_read_state(session_id).get("segment_index", -1)) + 1
    proc = _spawn_segment(session_id, src, next_idx)
    _active[session_id] = {"proc": proc, "segment": next_idx, "source": src}
    _guard_rtsp(session_id, src, next_idx, proc)
    log.info("recording: %s resumed (segment %d)", session_id, next_idx)
    return {"status": "recording"}


def _probe_duration(path: Path) -> int:
    if not FFPROBE or not path.exists():
        return 0
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=15,
        )
        return int(float(out.stdout.strip() or 0))
    except Exception:
        return 0


def _concat_segments(session_id: str) -> Path | None:
    sdir = _sdir(session_id)
    segs = sorted(sdir.glob("seg_*.ts"))
    if not segs:
        return None
    out = sdir / "video.mp4"
    concat = "concat:" + "|".join(str(s) for s in segs)
    try:
        subprocess.run(
            [FFMPEG, "-loglevel", "error", "-y", "-i", concat,
             "-c", "copy", "-movflags", "+faststart", str(out)],
            check=True, timeout=120,
            stdout=subprocess.DEVNULL, stderr=open(sdir / "ffmpeg.log", "ab"),
        )
        return out if out.exists() else None
    except Exception:
        log.exception("recording: concat failed for %s", session_id)
        return None


def stop(session_id: str) -> dict:
    """Finalise: stop capture, concat segments → video.mp4, probe duration,
    clean up the live HLS. Returns {video_key, duration, available}."""
    a = _active.pop(session_id, None)
    if a:
        _terminate(a.get("proc"))

    if not HAS_FFMPEG:
        _write_state(session_id, status="unavailable")
        return {"video_key": None, "duration": 0, "available": False}

    final = _concat_segments(session_id)
    duration = _probe_duration(final) if final else 0
    # tear down the live stream (recording is finished)
    try:
        shutil.rmtree(_hls_dir(session_id), ignore_errors=True)
    except Exception:
        pass
    video_key = f"recordings/{session_id}/video.mp4" if final else None
    file_size = final.stat().st_size if final and final.exists() else 0
    _write_state(session_id, status="complete", video_key=video_key, duration=duration,
                 file_size=file_size, ended_at=time.time())
    log.info("recording: %s complete → %s (%ds, %.1f MB)", session_id, video_key, duration, file_size / 1e6)
    return {"video_key": video_key, "video_path": video_key, "file_size": file_size,
            "duration": duration, "available": bool(final)}


def local_path(video_key: str | None):
    """Resolve a stored video_path key to an absolute Path under MEDIA_ROOT."""
    if not video_key:
        return None
    p = (MEDIA_ROOT / video_key).resolve()
    # contain within MEDIA_ROOT (no traversal)
    if MEDIA_ROOT.resolve() not in p.parents:
        return None
    return p if p.exists() else None


def restore() -> int:
    """On startup, reap orphan FFmpeg children left by a previous process and mark
    their sessions interrupted (we cannot reattach to a dead subprocess handle)."""
    if not REC_ROOT.exists():
        return 0
    reaped = 0
    for sd in REC_ROOT.iterdir():
        st = _read_state(sd.name)
        if st.get("status") in ("recording", "paused") and st.get("pid"):
            try:
                os.kill(int(st["pid"]), signal.SIGKILL)
                reaped += 1
            except Exception:
                pass
            _write_state(sd.name, status="interrupted")
    if reaped:
        log.warning("recording: reaped %d orphan ffmpeg process(es) on startup", reaped)
    return reaped


def status_label() -> str:
    return "ffmpeg" if HAS_FFMPEG else "unavailable"


def active_count() -> int:
    """Number of recordings whose FFmpeg child is alive right now (observability)."""
    return sum(1 for a in _active.values() if a.get("proc") and a["proc"].poll() is None)
