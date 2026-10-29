"""Google Drive archival — real Drive API v3 via a service account.

Configuration is read through ``utils.integration_config`` (the thin provider), so an
admin can configure Drive from the UI and it takes effect immediately — a saved DB row
OVERRIDES the env defaults; with no row the behaviour is exactly the historical env
check (``GOOGLE_DRIVE_CREDENTIALS`` file path + ``GOOGLE_DRIVE_FOLDER_ID``). Credentials
may be supplied either as a pasted/uploaded service-account JSON (stored encrypted) or as
a file path.

When unconfigured the service is INACTIVE (`is_configured()` is False) and the pipeline
keeps the local SSD copy — there is no placeholder upload and nothing is ever deleted
until a real upload has been size-verified.
"""
import hashlib
import json
import logging
import os
import time

from ..utils import integration_config

log = logging.getLogger("baywatch.drive")

_SCOPES = ["https://www.googleapis.com/auth/drive.file"]
_service = None
_service_fp = None      # config fingerprint the cached client was built for


def _cfg() -> dict:
    return integration_config.get_config("google_drive")


def is_configured() -> bool:
    return integration_config.is_configured("google_drive")


def _ready(cfg: dict | None = None) -> bool:
    """Credentials + destination folder are present (enough to build a client and
    run a connection test) — regardless of the admin's enable toggle, so an admin
    can Verify BEFORE switching archival on."""
    cfg = cfg or _cfg()
    has_cred = bool(cfg.get("credentials_json")) or bool(
        cfg.get("credentials_path") and os.path.exists(cfg["credentials_path"]))
    return bool(cfg.get("folder_id")) and has_cred


def _account_summary(cfg: dict | None = None) -> dict:
    """Non-secret identity of the configured service account (client_email /
    project_id) for the UI — NEVER the private key."""
    cfg = cfg or _cfg()
    try:
        data = json.loads(cfg.get("credentials_json") or "{}")
        return {"client_email": data.get("client_email"), "project_id": data.get("project_id")}
    except Exception:
        return {"client_email": None, "project_id": None}


def _short_folder(folder_id: str | None) -> str | None:
    if not folder_id:
        return None
    return folder_id if len(folder_id) <= 10 else folder_id[:6] + "…" + folder_id[-4:]


def _fingerprint(cfg: dict) -> str:
    src = cfg.get("credentials_json") or cfg.get("credentials_path") or ""
    return hashlib.sha256((src + "|" + (cfg.get("folder_id") or "")).encode()).hexdigest()


def _client(cfg: dict | None = None):
    """Build (and cache) the Drive client for the CURRENT config. The cache is keyed on
    a config fingerprint, so saving new credentials at runtime rebuilds the client."""
    global _service, _service_fp
    cfg = cfg or _cfg()
    if not _ready(cfg):
        return None
    fp = _fingerprint(cfg)
    if _service is not None and _service_fp == fp:
        return _service
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        if cfg.get("credentials_json"):
            info = json.loads(cfg["credentials_json"])
            creds = service_account.Credentials.from_service_account_info(info, scopes=_SCOPES)
        elif cfg.get("credentials_path") and os.path.exists(cfg["credentials_path"]):
            creds = service_account.Credentials.from_service_account_file(
                cfg["credentials_path"], scopes=_SCOPES)
        else:
            return None
        _service = build("drive", "v3", credentials=creds, cache_discovery=False)
        _service_fp = fp
        log.info("drive: client initialised (folder=%s)", cfg.get("folder_id"))
        return _service
    except Exception:
        log.exception("drive: failed to initialise client")
        return None


def health() -> dict:
    """Live status for the Storage dashboard / connection test. Probes BOTH the
    service account (Drive `about.get`) AND the destination folder (exists +
    writable), so a folder that was never shared with the service account reports
    honestly instead of looking connected — the #1 real-world setup mistake.
    Returns {configured, reachable, folder_writable, account, project_id,
    folder_id, folder_name, detail}. Never returns the private key."""
    cfg = _cfg()
    summ = _account_summary(cfg)
    base = {
        "configured": is_configured(),
        "account": summ.get("client_email"),
        "project_id": summ.get("project_id"),
        "folder_id": _short_folder(cfg.get("folder_id")),
    }
    if not _ready(cfg):
        return {**base, "reachable": False, "folder_writable": None,
                "detail": "Google Drive not configured — add a service-account JSON + destination "
                          "folder. Recordings stay on local SSD."}
    svc = _client(cfg)
    if not svc:
        return {**base, "reachable": False, "folder_writable": None,
                "detail": "Credentials present but the Drive client failed to initialise — check the "
                          "JSON, or the google-api-python-client / google-auth libraries are not installed."}
    try:
        about = svc.about().get(fields="user(emailAddress)").execute()
        acct = (about.get("user") or {}).get("emailAddress") or summ.get("client_email")
    except Exception as e:
        log.warning("drive: account probe failed (%s)", e.__class__.__name__)
        return {**base, "reachable": False, "folder_writable": None,
                "detail": f"Drive unreachable: {e.__class__.__name__}"}
    # folder access + writability — the real-world failure is "folder not shared".
    folder_id = cfg.get("folder_id")
    try:
        f = svc.files().get(fileId=folder_id, supportsAllDrives=True,
                            fields="id,name,trashed,capabilities(canAddChildren)").execute()
        if f.get("trashed"):
            return {**base, "account": acct, "reachable": True, "folder_writable": False,
                    "detail": "Destination folder is in Trash — choose a live folder."}
        writable = bool((f.get("capabilities") or {}).get("canAddChildren"))
        if not writable:
            return {**base, "account": acct, "reachable": True, "folder_writable": False,
                    "folder_name": f.get("name"),
                    "detail": f"Folder found but not writable — share it with {summ.get('client_email')} as Editor."}
        return {**base, "account": acct, "reachable": True, "folder_writable": True,
                "folder_name": f.get("name"), "detail": "Connected · folder writable"}
    except Exception:
        return {**base, "account": acct, "reachable": True, "folder_writable": False,
                "detail": f"Folder not found, or not shared with {summ.get('client_email')} — share it as Editor."}


def _find_or_create_folder(svc, name: str, parent_id: str) -> str:
    """Return the id of child folder `name` under `parent_id`, creating it if absent
    (idempotent — reuses an existing same-named, non-trashed folder)."""
    safe = (name or "").replace("\\", "\\\\").replace("'", "\\'")
    q = ("mimeType='application/vnd.google-apps.folder' and trashed=false "
         f"and name='{safe}' and '{parent_id}' in parents")
    try:
        res = svc.files().list(q=q, spaces="drive", fields="files(id,name)", pageSize=1,
                               supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
        files = res.get("files", [])
        if files:
            return files[0]["id"]
    except Exception:
        log.exception("drive: folder lookup failed for %r", name)
    meta = {"name": name, "mimeType": "application/vnd.google-apps.folder", "parents": [parent_id]}
    created = svc.files().create(body=meta, fields="id", supportsAllDrives=True).execute()
    return created["id"]


def _unique_name(svc, name: str, parent_id: str) -> str:
    """Avoid overwriting an existing Drive file with the same name in the same
    folder — append a short time suffix if one already exists."""
    safe = (name or "").replace("\\", "\\\\").replace("'", "\\'")
    q = f"name='{safe}' and trashed=false and '{parent_id}' in parents"
    try:
        res = svc.files().list(q=q, spaces="drive", fields="files(id)", pageSize=1,
                               supportsAllDrives=True, includeItemsFromAllDrives=True).execute()
        if not res.get("files"):
            return name
    except Exception:
        return name
    stem, dot, ext = name.rpartition(".")
    suffix = str(int(time.time()))[-6:]
    return f"{stem}_{suffix}{dot}{ext}" if dot else f"{name}_{suffix}"


def upload(local_path: str, name: str, subfolders: list[str] | None = None) -> dict | None:
    """Upload a finished recording and return {file_id, url, size, folder_id}.
    When `subfolders` is given (e.g. ['2026-06-20', 'Bay-01']) the file is placed
    inside that nested folder path under the configured root, creating folders as
    needed; with no subfolders it lands in the root (legacy flat behaviour).
    Verifies the remote size matches the local file before reporting success (so
    the caller only ever deletes a verified copy)."""
    cfg = _cfg()
    svc = _client(cfg)
    folder_id = cfg.get("folder_id")
    if not svc or not folder_id:
        return None
    try:
        from googleapiclient.http import MediaFileUpload
        parent = folder_id
        for sub in (subfolders or []):
            if sub:
                parent = _find_or_create_folder(svc, str(sub), parent)
        final_name = _unique_name(svc, name, parent)
        local_size = os.path.getsize(local_path)
        meta = {"name": final_name, "parents": [parent]}
        media = MediaFileUpload(local_path, mimetype="video/mp4", resumable=True)
        f = svc.files().create(body=meta, media_body=media, supportsAllDrives=True,
                               fields="id,size,webViewLink").execute()
        fid = f["id"]
        remote_size = int(f.get("size") or 0)
        if remote_size and local_size and remote_size != local_size:
            log.error("drive: size mismatch for %s (local=%d remote=%d) — keeping local",
                      final_name, local_size, remote_size)
            try:
                svc.files().delete(fileId=fid, supportsAllDrives=True).execute()
            except Exception:
                pass
            return None
        try:  # link-shareable (anyone with the link can view)
            svc.permissions().create(fileId=fid, body={"type": "anyone", "role": "reader"},
                                     supportsAllDrives=True).execute()
        except Exception:
            log.warning("drive: could not set public sharing on %s", fid)
        url = f.get("webViewLink") or f"https://drive.google.com/file/d/{fid}/view"
        log.info("drive: uploaded %s → %s (%.1f MB)", final_name, fid, (remote_size or local_size) / 1e6)
        return {"file_id": fid, "url": url, "size": remote_size or local_size, "folder_id": parent}
    except Exception:
        log.exception("drive: upload failed for %s", name)
        return None


def exists(file_id: str) -> bool:
    """Confirm an archived file is REALLY still on Drive (Verify Drive Link). A
    trashed/removed file returns False so the UI can show 'drive missing' honestly
    instead of a dead link."""
    svc = _client()
    if not svc or not file_id:
        return False
    try:
        f = svc.files().get(fileId=file_id, fields="id,trashed").execute()
        return bool(f.get("id")) and not f.get("trashed", False)
    except Exception:
        log.warning("drive: exists() probe failed for %s", file_id)
        return False


def delete(file_id: str) -> bool:
    svc = _client()
    if not svc or not file_id:
        return False
    try:
        svc.files().delete(fileId=file_id).execute()
        log.info("drive: deleted %s", file_id)
        return True
    except Exception:
        log.exception("drive: delete failed for %s", file_id)
        return False
