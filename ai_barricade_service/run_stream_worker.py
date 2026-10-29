"""CLI entry to run the RTSP stream workers standalone (Phase E).

Fetches enabled barricade cameras from the backend's internal config endpoint and starts one worker
per camera, then blocks until Ctrl-C. Explicit start only — nothing auto-starts on import.

    BSMS_BACKEND_URL=http://localhost:8000/api/v1 \
    BARRICADE_INTERNAL_TOKEN=<matches backend BARRICADE_INGEST_TOKEN> \
      python run_stream_worker.py

Use BARRICADE_INTERNAL_TOKEN in production; AI_BARRICADE_BEARER (admin/master JWT) is a dev/test
alternative. Secrets come from the environment and are never logged.
"""
import logging
import os
import signal
import time

from stream_worker import StreamManager, StreamConfig

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("barricade.run")


def main():
    cfg = StreamConfig(
        backend_url=os.environ.get("BSMS_BACKEND_URL", "http://localhost:8000/api/v1"),
        internal_token=os.environ.get("BARRICADE_INTERNAL_TOKEN") or None,
        bearer=os.environ.get("AI_BARRICADE_BEARER") or None)
    mgr = StreamManager(cfg)
    status = mgr.start(use_backend_config=True)
    log.info("stream workers started · %d camera(s)", len(status.get("cameras", [])))
    stop = {"v": False}

    def _sig(*_a):
        stop["v"] = True
    signal.signal(signal.SIGINT, _sig)
    signal.signal(signal.SIGTERM, _sig)
    try:
        while not stop["v"]:
            time.sleep(1)
    finally:
        mgr.stop()
        log.info("stream workers stopped")


if __name__ == "__main__":
    main()
