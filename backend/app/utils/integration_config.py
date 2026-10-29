"""Integration config provider — the ONE place every service reads external-service
configuration through.

A DB row (``integration_settings``) OVERRIDES the matching env-var defaults at
runtime; **no DB row → pure env behaviour (unchanged)**. Saving config invalidates a
small in-process cache so a change takes effect immediately with no backend restart.

Secrets are encrypted at rest with Fernet and are NEVER returned to the frontend in
the clear — call :func:`mask_config` for the frontend-safe shape (``••••abcd``). Use
:func:`get_config` only inside the backend (it decrypts).

Background callers (scheduler / services) may pass ``db=None`` — a short-lived
``SessionLocal`` is opened and closed internally.
"""
import base64
import hashlib
import json
import logging
import os

from sqlalchemy import select

from ..config import settings
from ..models.base import naive_utcnow
from ..models.integration_settings import IntegrationSettings, PROVIDERS

log = logging.getLogger("baywatch.integrations")


# ── per-provider spec: env fallbacks + which keys are secret ────────────────
def _env_google_drive() -> dict:
    return {
        "folder_id": settings.google_drive_folder_id or "",
        "credentials_path": settings.google_drive_credentials or "",
        # operational knobs (not env-backed today — sensible defaults)
        "retention_days": settings.recording_retention_days,
        "sync_interval_hours": 6,
        "delete_local_after_upload": True,
        "keep_local_until_verified": True,
    }


def _env_mqtt_timer() -> dict:
    return {
        "enabled": bool(settings.mqtt_enabled),
        "broker_host": settings.mqtt_broker_host or "",
        "broker_port": settings.mqtt_broker_port,
        "protocol": "mqtt",                              # mqtt | mqtts | ws | wss
        "username": settings.mqtt_username or "",
        "client_id": "baywatch-backend",
        "topic_prefix": settings.mqtt_topic_prefix or "bay",
        "command_topic_pattern": "{prefix}/{bay}/{event}",
        "status_topic_pattern": "{prefix}/{bay}/timer",
        "qos": 1,
        "keepalive": 30,
        "tls_enabled": False,
        "ca_cert": "",
        "retain_state": True,
        "reconnect_attempts": 5,
        "reconnect_backoff": 30,
        "heartbeat_timeout": 15,
        "connection_timeout": 6,
        "test_topic": "bay/test",
        "test_payload": "baywatch-ping",
    }


def _env_camera() -> dict:
    # Branch-wide CAPTURE DEFAULTS (the per-bay RTSP URLs live in the BayCamera
    # registry; these only fill gaps + drive the connection test). No env today →
    # sensible hardcoded defaults are the fallback.
    return {
        "protocol": "rtsp",                              # rtsp | onvif
        "rtsp_transport": "tcp",                         # tcp | udp
        "default_rtsp_path": "/Streaming/Channels/101",
        "connection_timeout": 10,
        "reconnect_attempts": 3,
        "reconnect_backoff": 5,
        "snapshot_enabled": True,
        "probe_snapshot_enabled": True,
        "recording_resolution": "1280x720",
        "fps": 15,
        "ffmpeg_path": "",                               # blank → system ffmpeg (shutil.which)
        "ffmpeg_input_flags": "",
        "default_username": "",                          # default camera login (non-secret)
        "test_rtsp_url": "",                             # connection-test target
        "test_camera_ip": "",
        "test_port": 554,
    }


def _env_whatsapp() -> dict:
    return {
        "business_account_id": "",                                      # WABA id (no env default)
        "phone_number_id": settings.whatsapp_phone_number_id or "",
        "api_version": settings.whatsapp_api_version or "v21.0",
        "default_country_code": settings.whatsapp_default_country_code or "91",
        # separate approved templates for the two customer-link flows
        "live_template_name": settings.whatsapp_template_name or "service_live_link",
        "live_template_lang": settings.whatsapp_template_lang or "en",
        "approval_template_name": "service_estimate_approval",
        "approval_template_lang": settings.whatsapp_template_lang or "en",
        "test_recipient": "",                                          # optional number for a test send
    }


# secret_keys → stored only in the Fernet blob; never returned unmasked.
SPEC = {
    "google_drive": {"secret_keys": ("credentials_json",), "env": _env_google_drive},
    "mqtt_timer":   {"secret_keys": ("password",),          "env": _env_mqtt_timer},
    "camera":       {"secret_keys": ("default_password",),   "env": _env_camera},
    "whatsapp":     {"secret_keys": ("access_token",),      "env": _env_whatsapp},
}

# Providers an admin can actually save/test. (All four are now real.)
WRITABLE = ("google_drive", "whatsapp", "camera", "mqtt_timer")


# ── Fernet (encryption at rest) ─────────────────────────────────────────────
_fernet = None


def _make_key(raw: str) -> bytes:
    """Accept a real Fernet key verbatim; otherwise derive a stable 32-byte key from
    the given string (so a plain `integration_secret_key` or `jwt_secret` works)."""
    from cryptography.fernet import Fernet
    try:
        candidate = raw.encode()
        Fernet(candidate)            # validates length/format
        return candidate
    except Exception:
        return base64.urlsafe_b64encode(hashlib.sha256(raw.encode()).digest())


def _f():
    global _fernet
    if _fernet is None:
        from cryptography.fernet import Fernet
        seed = settings.integration_secret_key or settings.jwt_secret
        _fernet = Fernet(_make_key(seed))
    return _fernet


def _encrypt(plain: str) -> str:
    return _f().encrypt(plain.encode()).decode()


def _decrypt(token: str) -> str | None:
    try:
        return _f().decrypt(token.encode()).decode()
    except Exception:
        log.warning("integrations: could not decrypt a stored secret (key changed?)")
        return None


# ── cache (invalidated on save / test) ──────────────────────────────────────
_cache: dict[str, dict] = {}


def invalidate(provider: str | None = None) -> None:
    if provider is None:
        _cache.clear()
    else:
        _cache.pop(provider, None)


def _row(db, provider: str) -> IntegrationSettings | None:
    return db.scalar(
        select(IntegrationSettings).where(
            IntegrationSettings.provider == provider,
            IntegrationSettings.branch_id.is_(None),
        )
    )


# ── read (DB overrides env) ─────────────────────────────────────────────────
def get_config(provider: str, db=None) -> dict:
    """Full (decrypted) config for backend use: env defaults with the DB row merged
    over them. ``_has_row`` / ``status`` / ``enabled`` describe the DB state. No DB
    row → exactly the env config (today's behaviour). Backend-only — never serialise
    this dict to a client (use :func:`mask_config`)."""
    if provider not in SPEC:
        raise ValueError(f"unknown provider {provider!r}")
    if provider in _cache:
        return dict(_cache[provider])

    spec = SPEC[provider]
    cfg = dict(spec["env"]())
    cfg.setdefault("enabled", False)
    cfg["status"] = "not_configured"
    cfg["_has_row"] = False
    for k in spec["secret_keys"]:
        cfg.setdefault(k, "")

    own = False
    if db is None:
        from ..database import SessionLocal
        db = SessionLocal()
        own = True
    try:
        row = _row(db, provider)
        if row:
            cfg["_has_row"] = True
            cfg["status"] = row.status
            cfg["enabled"] = bool(row.enabled)
            if row.config_json:
                try:
                    cfg.update(json.loads(row.config_json))
                except Exception:
                    log.warning("integrations: bad config_json for %s", provider)
            if row.secret_json:
                secrets = json.loads(_decrypt(row.secret_json) or "{}")
                for k in spec["secret_keys"]:
                    if secrets.get(k):
                        cfg[k] = secrets[k]
    finally:
        if own:
            db.close()

    _cache[provider] = dict(cfg)
    return dict(cfg)


def is_configured(provider: str, cfg: dict | None = None, db=None) -> bool:
    """Whether a provider has everything it needs to actually run. For a saved
    (DB) row the admin's ``enabled`` toggle also gates it; with no row it mirrors the
    historical env check so existing behaviour is untouched."""
    cfg = cfg or get_config(provider, db)
    if provider == "google_drive":
        has_cred = bool(cfg.get("credentials_json")) or bool(
            cfg.get("credentials_path") and os.path.exists(cfg["credentials_path"]))
        ready = bool(cfg.get("folder_id")) and has_cred
        return (cfg.get("enabled", False) and ready) if cfg.get("_has_row") else ready
    if provider == "mqtt_timer":
        return bool(cfg.get("enabled") and cfg.get("broker_host"))
    if provider == "whatsapp":
        return bool(cfg.get("phone_number_id") and cfg.get("access_token"))
    if provider == "camera":
        # camera defaults are optional fillers — "configured" = admin enabled them
        return bool(cfg.get("enabled"))
    return False


# ── write (upsert; blank secret keeps the existing one) ─────────────────────
def save_config(db, provider: str, config: dict | None, secrets: dict | None, user=None):
    """Upsert the provider row. Non-secret keys merge into ``config_json``; a blank/
    omitted secret KEEPS the existing encrypted value, a non-blank one re-encrypts.
    Invalidates the cache so the change is live immediately."""
    if provider not in SPEC:
        raise ValueError(f"unknown provider {provider!r}")
    spec = SPEC[provider]
    config = config or {}
    secrets = secrets or {}

    row = _row(db, provider)
    if not row:
        row = IntegrationSettings(provider=provider, branch_id=None,
                                  created_by=(user.id if user else None))
        db.add(row)

    # merge non-secret config (drop control + secret keys that may have leaked in)
    existing_cfg = {}
    if row.config_json:
        try:
            existing_cfg = json.loads(row.config_json)
        except Exception:
            existing_cfg = {}
    for k, v in config.items():
        if k.startswith("_") or k in spec["secret_keys"] or k in ("enabled", "status"):
            continue
        existing_cfg[k] = v
    row.config_json = json.dumps(existing_cfg)

    if "enabled" in config:
        row.enabled = bool(config["enabled"])

    # secrets: blank → keep existing, non-blank → replace
    existing_secrets = {}
    if row.secret_json:
        try:
            existing_secrets = json.loads(_decrypt(row.secret_json) or "{}")
        except Exception:
            existing_secrets = {}
    for k in spec["secret_keys"]:
        v = secrets.get(k)
        if v is None or v == "":
            continue
        existing_secrets[k] = v
    if existing_secrets:
        row.secret_json = _encrypt(json.dumps(existing_secrets))

    # status: configured + enabled = active is only confirmed by a successful test,
    # so a fresh save lands at dormant (configured) or not_configured.
    full = dict(existing_cfg)
    full["_has_row"] = True
    full["enabled"] = row.enabled
    for k in spec["secret_keys"]:
        full[k] = existing_secrets.get(k, "")
    row.status = "dormant" if is_configured(provider, full) else "not_configured"
    row.updated_by = user.id if user else None
    row.updated_at = naive_utcnow()

    db.commit()
    invalidate(provider)
    return row


def disconnect(db, provider: str, user=None):
    """Service-account 'Disconnect': forget the stored credentials and disable the
    integration so it stops running. Does NOT touch any recording or uploaded Drive
    file — only the saved config. Clears the encrypted secret blob, disables, and
    resets status to not_configured. (folder_id is non-secret and kept so a
    re-connect only needs fresh credentials; the integration is inert without a
    secret.)"""
    if provider not in SPEC:
        raise ValueError(f"unknown provider {provider!r}")
    row = _row(db, provider)
    if row:
        row.secret_json = None
        row.enabled = False
        row.status = "not_configured"
        row.last_error = None
        row.last_success_at = None
        row.last_tested_at = None
        row.updated_by = user.id if user else None
        row.updated_at = naive_utcnow()
        db.commit()
    invalidate(provider)
    return row


def record_test(db, provider: str, ok: bool, error: str | None = None):
    """Stamp the outcome of a connection test onto the row (status/timestamps/error)."""
    row = _row(db, provider)
    if not row:
        return None
    now = naive_utcnow()
    row.last_tested_at = now
    if ok:
        row.last_success_at = now
        row.last_error = None
        row.status = "active" if row.enabled else "dormant"
    else:
        row.last_error = (error or "")[:500]
        row.status = "failed"
    db.commit()
    invalidate(provider)
    return row


# ── frontend-safe masking ───────────────────────────────────────────────────
def _mask(value: str) -> str:
    if not value:
        return ""
    tail = value[-4:] if len(value) > 4 else value
    return "••••••" + tail


def _drive_cred_summary(credentials_json: str) -> dict | None:
    """Non-secret identity of a saved service account (client_email / project_id) so
    the UI can show WHICH account is configured — never the private key."""
    try:
        data = json.loads(credentials_json)
        return {"client_email": data.get("client_email"),
                "project_id": data.get("project_id"),
                "type": data.get("type")}
    except Exception:
        return None


def mask_config(provider: str, full: dict | None = None) -> dict:
    """The ONLY config shape returned to the frontend: non-secret config verbatim,
    every secret reduced to ``{set, masked}``, plus ``configured``/``enabled``/
    ``status``. No raw secret ever crosses this boundary."""
    if provider not in SPEC:
        raise ValueError(f"unknown provider {provider!r}")
    spec = SPEC[provider]
    full = full if full is not None else get_config(provider)

    out = {}
    for k, v in full.items():
        if k.startswith("_") or k in spec["secret_keys"]:
            continue
        out[k] = v

    secrets_meta = {}
    for k in spec["secret_keys"]:
        v = full.get(k) or ""
        secrets_meta[k] = {"set": bool(v), "masked": (_mask(v) if v else None)}
    out["secrets"] = secrets_meta

    if provider == "google_drive" and full.get("credentials_json"):
        out["credentials_summary"] = _drive_cred_summary(full["credentials_json"])

    out["provider"] = provider
    out["enabled"] = bool(full.get("enabled"))
    out["status"] = full.get("status", "not_configured")
    out["configured"] = is_configured(provider, full)
    out["writable"] = provider in WRITABLE
    return out


def status_meta(db, provider: str) -> dict:
    """Row-level test/health metadata for the status cards (no secrets)."""
    row = _row(db, provider)
    if not row:
        return {"status": "not_configured", "enabled": False,
                "last_tested_at": None, "last_success_at": None, "last_error": None}
    return {
        "status": row.status,
        "enabled": bool(row.enabled),
        "last_tested_at": row.last_tested_at.isoformat() if row.last_tested_at else None,
        "last_success_at": row.last_success_at.isoformat() if row.last_success_at else None,
        "last_error": row.last_error,
    }
