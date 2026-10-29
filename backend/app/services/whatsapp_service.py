"""WhatsApp Business — Meta Cloud API (Graph) sender for customer links (Live Watch +
Estimate Approval).

Configuration is read through ``utils.integration_config`` (the thin provider), so an
admin can configure WhatsApp from the UI and it takes effect immediately — a saved DB
row OVERRIDES the env defaults; with no row the behaviour is exactly the historical env
check. The access token is stored ONLY as a Fernet-encrypted secret and never returned
to the frontend in the clear.

Plain HTTP via ``urllib`` (mirrors the MSG91 SMS sender — no SDK dependency, sync). When
the Meta credentials are unset the send is a graceful no-op so the admin's Copy-Link path
is never blocked. Meta only delivers TEMPLATE messages to a number that has not messaged
the business first, so this always sends an approved template (``template_name``), e.g.::

    Body  : "Hello {{1}}, your vehicle service has started. Watch it live below.
             This link is temporary and will expire automatically."
    Button: URL (dynamic) → https://<domain>/customer-watch/{{1}}

so the customer name is passed as the body param and the token as the URL-button param.
"""
import json
import logging
import urllib.error
import urllib.request

from ..utils import integration_config

log = logging.getLogger("baywatch.whatsapp")


def _cfg() -> dict:
    return integration_config.get_config("whatsapp")


def is_configured() -> bool:
    return integration_config.is_configured("whatsapp")


def normalize_msisdn(mobile: str | None, cfg: dict | None = None) -> str | None:
    """E.164 digits with no '+'. A bare local 10-digit number gets the default country code."""
    if not mobile:
        return None
    digits = "".join(ch for ch in str(mobile) if ch.isdigit())
    if not digits:
        return None
    if len(digits) == 10:
        cc = (cfg or _cfg()).get("default_country_code") or "91"
        digits = str(cc) + digits
    return digits


def health() -> dict:
    """Live status for the integration status card / connection test. A real, lightweight
    probe (GET the phone-number node) confirms the token + phone_number_id actually work —
    not just that they are present. Returns {configured, reachable, detail, ...}."""
    cfg = _cfg()
    pnid = cfg.get("phone_number_id")
    if not is_configured():
        return {"configured": False, "reachable": False,
                "detail": "WhatsApp not configured — Copy-Link still works; messages won't auto-send."}
    api_version = cfg.get("api_version") or "v21.0"
    url = (f"https://graph.facebook.com/{api_version}/{pnid}"
           "?fields=verified_name,display_phone_number,quality_rating")
    req = urllib.request.Request(url, method="GET",
            headers={"Authorization": f"Bearer {cfg.get('access_token')}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode() or "{}")
        return {"configured": True, "reachable": True,
                "number": body.get("display_phone_number"),
                "name": body.get("verified_name"),
                "quality": body.get("quality_rating"),
                "detail": f"Connected · {body.get('verified_name') or body.get('display_phone_number') or pnid}"}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore")[:200]
        log.warning("whatsapp: health probe %s — %s", e.code, detail)
        msg = "Invalid access token or phone number id." if e.code in (400, 401) else f"Graph API error {e.code}."
        return {"configured": True, "reachable": False, "detail": msg}
    except Exception as e:
        log.exception("whatsapp: health probe failed")
        return {"configured": True, "reachable": False,
                "detail": f"WhatsApp unreachable: {e.__class__.__name__}"}


def send_watch_link(mobile: str | None, customer_name: str | None, token: str) -> dict:
    """Send the live-watch / approval link as an approved template. Returns a result dict and
    never raises — the caller records ``whatsapp_status`` and audits regardless of outcome."""
    cfg = _cfg()
    if not is_configured():
        return {"ok": False, "skipped": True, "status": "not_configured",
                "message": "WhatsApp is not configured — share the copied link manually."}
    to = normalize_msisdn(mobile, cfg)
    if not to:
        return {"ok": False, "status": "invalid_number",
                "message": "No valid mobile number on the job card."}

    api_version = cfg.get("api_version") or "v21.0"
    url = f"https://graph.facebook.com/{api_version}/{cfg.get('phone_number_id')}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "template",
        "template": {
            "name": cfg.get("live_template_name") or cfg.get("template_name") or "service_live_link",
            "language": {"code": cfg.get("live_template_lang") or cfg.get("template_lang") or "en"},
            "components": [
                {"type": "body",
                 "parameters": [{"type": "text", "text": customer_name or "Customer"}]},
                {"type": "button", "sub_type": "url", "index": "0",
                 "parameters": [{"type": "text", "text": token}]},
            ],
        },
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {cfg.get('access_token')}",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode() or "{}")
        mid = (body.get("messages") or [{}])[0].get("id")
        return {"ok": True, "status": "sent", "message_id": mid}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore")[:300]
        log.warning("whatsapp: Meta API %s — %s", e.code, detail)
        return {"ok": False, "status": "failed",
                "message": f"WhatsApp send failed ({e.code}).", "detail": detail}
    except Exception as e:
        log.exception("whatsapp: send failed")
        return {"ok": False, "status": "failed", "message": f"WhatsApp send error: {e}"}


def send_approval_link(mobile: str | None, customer_name: str | None, token: str) -> dict:
    """Send the Customer Estimate Approval link as the approved approval template
    (``approval_template_name``). Same contract as :func:`send_watch_link` — never raises,
    honest result; the admin's Copy-Link path always works regardless of the outcome."""
    cfg = _cfg()
    if not is_configured():
        return {"ok": False, "skipped": True, "status": "not_configured",
                "message": "WhatsApp is not configured — copy the approval link and share it manually."}
    to = normalize_msisdn(mobile, cfg)
    if not to:
        return {"ok": False, "status": "invalid_number",
                "message": "No valid customer mobile number on the job card."}

    api_version = cfg.get("api_version") or "v21.0"
    url = f"https://graph.facebook.com/{api_version}/{cfg.get('phone_number_id')}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "template",
        "template": {
            "name": cfg.get("approval_template_name") or "service_estimate_approval",
            "language": {"code": cfg.get("approval_template_lang") or "en"},
            "components": [
                {"type": "body",
                 "parameters": [{"type": "text", "text": customer_name or "Customer"}]},
                {"type": "button", "sub_type": "url", "index": "0",
                 "parameters": [{"type": "text", "text": token}]},
            ],
        },
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": f"Bearer {cfg.get('access_token')}",
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode() or "{}")
        mid = (body.get("messages") or [{}])[0].get("id")
        return {"ok": True, "status": "sent", "message_id": mid}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="ignore")[:300]
        log.warning("whatsapp: approval send Meta API %s — %s", e.code, detail)
        return {"ok": False, "status": "failed",
                "message": f"WhatsApp send failed ({e.code}).", "detail": detail}
    except Exception as e:
        log.exception("whatsapp: approval send failed")
        return {"ok": False, "status": "failed", "message": f"WhatsApp send error: {e}"}
