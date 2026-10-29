"""Production startup validation — operational hardening only (no business logic).

In **development** (APP_ENV unset / "development") this NEVER blocks boot: it only
logs WARNINGs about insecure config so the operator notices. In **production**
(APP_ENV=production) genuine security/operational BLOCKERS fail-fast with a
RuntimeError so a misconfigured deploy stops loudly instead of running insecure.

Optional integrations (Google Drive, WhatsApp, MQTT, cameras) are NEVER blockers —
they are designed to degrade gracefully and are surfaced via /health + /ready.

No secret VALUE is ever logged or placed in an error — only the NAME of the setting
that needs attention.
"""
import logging
import os
from pathlib import Path

from .config import settings

log = logging.getLogger("baywatch.startup")

_DEFAULT_JWT = "change-me-to-a-long-random-secret"


def media_root() -> Path:
    """Resolve the recording media root the same way recording_service does, without
    importing it (keep validation light and import-cycle free)."""
    env = os.environ.get("BW_MEDIA_ROOT")
    return Path(env) if env else (Path(__file__).resolve().parents[1] / "media")


def media_writable() -> bool:
    try:
        root = media_root()
        root.mkdir(parents=True, exist_ok=True)
        probe = root / ".write_probe"
        probe.write_text("ok")
        probe.unlink()
        return True
    except Exception:
        return False


def is_production() -> bool:
    return (settings.app_env or "").strip().lower() == "production"


def collect() -> tuple[list[str], list[str]]:
    """Return (blockers, warnings). `blockers` fail-fast only in production."""
    s = settings
    blockers: list[str] = []
    warnings: list[str] = []

    def flag(cond: bool, msg: str, *, blocker: bool) -> None:
        if cond:
            (blockers if blocker else warnings).append(msg)

    # ── genuine production blockers (mentioned in dev too, but never block there) ──
    weak_jwt = (not s.jwt_secret) or s.jwt_secret == _DEFAULT_JWT or len(s.jwt_secret) < 32
    flag(weak_jwt, "JWT_SECRET is unset/default/too short — set a strong 32+ char secret (openssl rand -hex 32)", blocker=True)
    flag(not s.integration_secret_key,
         "INTEGRATION_SECRET_KEY is unset — provider secrets fall back to a key derived from JWT_SECRET; set a dedicated key in production", blocker=True)
    flag(s.database_url.startswith("sqlite"),
         "DATABASE_URL is SQLite — production must use PostgreSQL (postgresql+psycopg://…)", blocker=True)
    flag(s.seed_on_startup,
         "SEED_ON_STARTUP is true — production must not auto-seed default-credential users (bootstrap once, change passwords, then set false)", blocker=True)
    cwb = (s.customer_watch_base_url or "").lower()
    flag((not cwb) or ("localhost" in cwb) or ("127.0.0.1" in cwb),
         "CUSTOMER_WATCH_BASE_URL is localhost/empty — customer watch links will break; set the public https origin", blocker=True)
    flag("*" in s.cors_list,
         "CORS_ORIGINS contains a wildcard '*' — lock it to your real frontend origin(s) in production", blocker=True)
    flag(not media_writable(),
         "Recording media root is not writable — set BW_MEDIA_ROOT to a writable, persistent volume", blocker=True)

    # ── always warnings (operational hygiene, never a blocker) ──
    flag(s.minio_access_key == "minioadmin" or s.minio_secret_key == "minioadmin",
         "MinIO/S3 credentials are the default minioadmin — change them if MinIO is reachable", blocker=False)
    flag(s.jwt_expire_minutes >= 1440,
         f"JWT_EXPIRE_MINUTES is large ({s.jwt_expire_minutes}m) — consider a shorter production session", blocker=False)

    # ── optional integrations: reported only, NEVER blockers ──
    try:
        from .services import drive_service
        if not drive_service.is_configured():
            warnings.append("Google Drive archival not configured — recordings stay on local SSD (optional)")
    except Exception:
        pass
    if not (s.mqtt_enabled and s.mqtt_broker_host):
        warnings.append("MQTT (ESP32 physical timers) disabled/unset — backend timer stays source of truth (optional)")
    if not s.whatsapp_access_token:
        warnings.append("WhatsApp Business not configured — Copy-Link still works (optional)")

    return blockers, warnings


def validate_startup() -> None:
    """Log config warnings; in production, fail-fast on genuine blockers."""
    prod = is_production()
    blockers, warnings = collect()
    for w in warnings:
        log.warning("config: %s", w)
    if blockers and prod:
        log.error("config: %d production blocker(s) — refusing to start:", len(blockers))
        for b in blockers:
            log.error("config:   ✗ %s", b)
        raise RuntimeError("Production startup blocked by insecure/incomplete config — "
                           + "; ".join(blockers))
    if blockers and not prod:
        for b in blockers:
            log.warning("config: (would block in production) %s", b)
    log.info("config: startup validation ok · mode=%s · warnings=%d%s",
             "production" if prod else "development", len(warnings),
             "" if (prod or not blockers) else f" · would-block-in-prod={len(blockers)}")
