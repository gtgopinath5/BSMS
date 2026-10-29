"""Integrations & Configuration (admin) — configure external services from the UI.

One control surface over the ``integration_settings`` provider. This pass ships the
**Google Drive** tab fully working; MQTT / Camera / WhatsApp are honest placeholders
(read-only status, no fake save/test).

    GET  /api/v1/integrations/status            → 4-provider summary (status cards)
    GET  /api/v1/integrations/{provider}        → MASKED config (never raw secrets)
    PUT  /api/v1/integrations/{provider}         → save (google_drive writable this pass)
    POST /api/v1/integrations/{provider}/test    → connection test (drive = real probe)
    POST /api/v1/integrations/google_drive/sync-now → gate + run the archive sweep

Security: secrets are Fernet-encrypted at rest, only masked values cross to the client,
a blank secret on save keeps the existing one, nothing secret is logged, and every route
is ``require_admin`` (workers/customers blocked).
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.integration_settings import PROVIDERS
from ..models.user import User
from ..schemas.common import ok
from ..services import camera_service, drive_service, mqtt_service, scheduler_service, whatsapp_service
from ..utils import integration_config
from ..utils.audit import log_action
from ..utils.auth import require_admin

log = logging.getLogger("baywatch.integrations")
router = APIRouter()

LABELS = {
    "google_drive": "Google Drive Storage",
    "mqtt_timer": "Timer / MQTT",
    "camera": "Camera / RTSP",
    "whatsapp": "WhatsApp",
}


class SaveBody(BaseModel):
    config: dict = {}
    secrets: dict = {}


def _provider_status(db: Session, provider: str) -> dict:
    meta = integration_config.status_meta(db, provider)
    out = {**meta, "provider": provider, "label": LABELS.get(provider, provider),
           "writable": provider in integration_config.WRITABLE}
    if provider == "google_drive":
        out["configured"] = drive_service.is_configured()
    elif provider == "mqtt_timer":
        st = mqtt_service.status()
        out["configured"] = mqtt_service.is_configured()
        out["connected"] = st.get("connected")
        out["broker"] = st.get("broker")
        out["last_message"] = st.get("last_message")
    elif provider == "whatsapp":
        out["configured"] = whatsapp_service.is_configured()
    elif provider == "camera":
        out["configured"] = camera_service.is_configured()
    else:
        out["configured"] = False
    return out


@router.get("/status")
def status_summary(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Summary card data for all four providers."""
    return ok({"providers": [_provider_status(db, p) for p in PROVIDERS]})


@router.get("/{provider}")
def get_provider(provider: str, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Masked config for one provider (no raw secrets ever)."""
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown integration")
    full = integration_config.get_config(provider, db)
    masked = integration_config.mask_config(provider, full)
    masked["meta"] = integration_config.status_meta(db, provider)
    if provider == "mqtt_timer":
        masked["live"] = mqtt_service.status()      # broker connected / last message
    return ok(masked)


def _validate_drive(config: dict, secrets: dict) -> None:
    cj = (secrets or {}).get("credentials_json")
    if cj:
        try:
            data = json.loads(cj)
        except Exception:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Service-account credentials must be valid JSON.")
        if data.get("type") != "service_account" or not data.get("private_key") \
                or not data.get("client_email"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "That JSON is not a Google service-account key "
                                "(expected type=service_account with private_key + client_email).")


def _prep_camera_save(config: dict, secrets: dict) -> None:
    """Never persist credentials in the plaintext Test RTSP URL: strip any embedded
    `user:pass@` and route it to default_username (non-secret) + default_password
    (encrypted). The probe re-injects the default login, so the test still works."""
    from urllib.parse import urlsplit, urlunsplit
    url = (config.get("test_rtsp_url") or "").strip()
    if not url or "@" not in url:
        return
    try:
        p = urlsplit(url)
        if "@" not in p.netloc:
            return
        creds, host = p.netloc.split("@", 1)
        user = creds.split(":")[0] if creds else ""
        pwd = creds.split(":", 1)[1] if ":" in creds else ""
        config["test_rtsp_url"] = urlunsplit(p._replace(netloc=host))   # creds stripped
        if user and not (config.get("default_username") or "").strip():
            config["default_username"] = user
        if pwd and not (secrets.get("default_password") or "").strip():
            secrets["default_password"] = pwd
    except Exception:
        config["test_rtsp_url"] = ""


@router.put("/{provider}")
def save_provider(provider: str, body: SaveBody,
                  admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown integration")
    if provider not in integration_config.WRITABLE:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"{LABELS.get(provider, provider)} configuration is ready but "
                            "will be enabled in the next pass.")
    if provider == "google_drive":
        _validate_drive(body.config, body.secrets)
    if provider == "camera":
        _prep_camera_save(body.config, body.secrets)

    integration_config.save_config(db, provider, body.config, body.secrets, admin)
    masked = integration_config.mask_config(provider)
    # audit: provider + enabled + configured only — NEVER secret values
    log_action(db, "INTEGRATION_SAVE", "integration", provider, admin.id,
               new={"enabled": masked.get("enabled"), "configured": masked.get("configured")})
    db.commit()
    # live reconnect: apply the new broker config without a backend restart
    if provider == "mqtt_timer":
        try:
            masked["live"] = mqtt_service.reconnect()
        except Exception:
            log.exception("integrations: mqtt live-reconnect after save failed")
    masked["meta"] = integration_config.status_meta(db, provider)
    return ok(masked, f"{LABELS.get(provider, provider)} saved")


# Providers with a REAL connection probe (no fake success for the rest).
TESTERS = {"google_drive": drive_service.health, "whatsapp": whatsapp_service.health,
           "camera": camera_service.health, "mqtt_timer": mqtt_service.health}


@router.post("/{provider}/test")
def test_provider(provider: str, admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown integration")
    if provider not in TESTERS:
        return ok({"tested": False, "provider": provider},
                  f"Connection testing for {LABELS.get(provider, provider)} arrives in the next pass.")
    res = TESTERS[provider]()
    reachable = bool(res.get("reachable"))
    # Drive "success" requires the destination folder to be WRITABLE, not just the
    # account reachable — so a folder that was never shared with the service account
    # reports honestly as a failure (the #1 real-world setup mistake).
    success = (reachable and bool(res.get("folder_writable"))) if provider == "google_drive" else reachable
    integration_config.record_test(db, provider, success, None if success else res.get("detail"))
    log_action(db, "INTEGRATION_TEST", "integration", provider, admin.id,
               new={"reachable": reachable, "folder_writable": res.get("folder_writable")})
    db.commit()
    res["tested"] = True
    res["meta"] = integration_config.status_meta(db, provider)
    msg = res.get("detail") or (f"{LABELS.get(provider, provider)} connected" if success else "Test failed")
    return ok(res, msg)


@router.post("/google_drive/sync-now")
def drive_sync_now(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if not drive_service.is_configured():
        return ok({"configured": False, "started": False},
                  "Google Drive is not configured — configure Drive archival before syncing.")
    res = scheduler_service.sync_now()
    res["configured"] = True
    log_action(db, "STORAGE_SYNC_NOW", "integration", "google_drive", admin.id)
    db.commit()
    return ok(res, res.get("message", "Sync started"))


@router.post("/google_drive/disconnect")
def drive_disconnect(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Disconnect Drive: forget the service-account credentials + disable archival.
    Recordings and any already-uploaded Drive files are left untouched."""
    integration_config.disconnect(db, "google_drive", admin)
    log_action(db, "INTEGRATION_DISCONNECT", "integration", "google_drive", admin.id)
    db.commit()
    masked = integration_config.mask_config("google_drive")
    masked["meta"] = integration_config.status_meta(db, "google_drive")
    return ok(masked, "Google Drive disconnected — credentials removed, archival disabled. Recordings kept.")


@router.post("/mqtt_timer/reconnect")
def mqtt_reconnect(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    """Apply the saved MQTT config to the live broker connection now (no restart)."""
    st = mqtt_service.reconnect()
    log_action(db, "INTEGRATION_RECONNECT", "integration", "mqtt_timer", admin.id,
               new={"connected": st.get("connected")})
    db.commit()
    return ok(st, "Reconnected" if st.get("connected") else "Applied config — broker not connected yet")
