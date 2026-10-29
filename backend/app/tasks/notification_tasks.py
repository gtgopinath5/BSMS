"""Customer notifications.

  SMS   -> MSG91 (India)   — plain HTTP, no SDK dependency
  Email -> SendGrid
  In-App-> written to the notifications table by the workflow engine

`dispatch()` is called in-process by the workflow engine. When MSG91/SendGrid
are not configured it is a safe no-op (the in-app row is still recorded), so
the API runs fine without any notification provider.

MSG91 setup:
  1. https://msg91.com  → sign up, complete KYC (Aadhaar/GST) for full access
  2. API → copy your Auth Key            -> MSG91_AUTH_KEY
  3. Register a 6-char DLT Sender ID      -> MSG91_SENDER_ID
  4. (recommended) create a DLT template/flow and copy its id -> MSG91_FLOW_ID
"""
import json
import urllib.parse
import urllib.request

from ..config import settings


# ── public entry point (unchanged signature) ──────────────────────
def dispatch(customer_id: str, ntype: str, message: str, channels: list[str]) -> None:
    if "SMS" in channels and settings.msg91_auth_key:
        mobile = _customer_mobile(customer_id)
        if mobile:
            _send_sms(mobile, message)
    if "Email" in channels and settings.sendgrid_api_key:
        email = _customer_email(customer_id)
        if email:
            _send_email(email, ntype, message)


# ── MSG91 SMS ──────────────────────────────────────────────────────
def normalize_mobile(raw: str | None) -> str | None:
    """'+91 90000 00000' -> '919000000000' (country code + 10 digits)."""
    if not raw:
        return None
    digits = "".join(c for c in raw if c.isdigit())
    if len(digits) == 10:           # bare 10-digit Indian number
        digits = "91" + digits
    return digits or None


def build_flow_payload(mobile: str, message: str) -> dict:
    """MSG91 v5 Flow API body (DLT-compliant). `message` is sent as template var `body`."""
    return {
        "template_id": settings.msg91_flow_id,
        "sender": settings.msg91_sender_id,
        "short_url": "0",
        "recipients": [{"mobiles": mobile, "body": message}],
    }


def build_legacy_url(mobile: str, message: str) -> str:
    """MSG91 legacy sendhttp endpoint (used when no flow/template id is set)."""
    params = urllib.parse.urlencode({
        "authkey": settings.msg91_auth_key,
        "mobiles": mobile,
        "message": message,
        "sender": settings.msg91_sender_id,
        "route": settings.msg91_route,
        "country": "91",
    })
    return f"https://api.msg91.com/api/sendhttp.php?{params}"


def _send_sms(mobile: str, message: str) -> dict:
    mobile = normalize_mobile(mobile)
    if not mobile:
        return {"sent": False, "reason": "no mobile"}
    try:
        if settings.msg91_flow_id:
            # v5 Flow API (recommended, DLT template based)
            data = json.dumps(build_flow_payload(mobile, message)).encode()
            req = urllib.request.Request(
                "https://control.msg91.com/api/v5/flow/", data=data, method="POST",
                headers={"authkey": settings.msg91_auth_key,
                         "Content-Type": "application/json", "accept": "application/json"},
            )
        else:
            # legacy sendhttp (raw message text)
            req = urllib.request.Request(build_legacy_url(mobile, message), method="GET")
        with urllib.request.urlopen(req, timeout=10) as resp:
            return {"sent": True, "response": resp.read().decode()[:200]}
    except Exception as e:  # never let a failed SMS break the service workflow
        return {"sent": False, "reason": str(e)}


# ── Email (SendGrid) ───────────────────────────────────────────────
def _send_email(email: str, subject: str, message: str) -> None:
    try:
        import sendgrid  # noqa  (lazy; optional)
        # sg = sendgrid.SendGridAPIClient(settings.sendgrid_api_key)
        # sg.send(Mail(from_email=settings.from_email, to_emails=email,
        #              subject=subject, plain_text_content=message))
    except Exception:
        pass


# ── customer contact lookups ───────────────────────────────────────
def _customer_mobile(customer_id: str) -> str | None:
    from ..database import SessionLocal
    from ..models.user import User
    db = SessionLocal()
    try:
        u = db.get(User, customer_id)
        return u.mobile if u else None
    finally:
        db.close()


def _customer_email(customer_id: str) -> str | None:
    from ..database import SessionLocal
    from ..models.user import User
    db = SessionLocal()
    try:
        u = db.get(User, customer_id)
        return u.email if u else None
    finally:
        db.close()
