"""Completion-PDF generation. Uses WeasyPrint (HTML->PDF) when installed;
imported lazily so the API boots without system cairo/pango.
"""
from ..database import SessionLocal
from ..models.session import ServiceSession, RecordingSession
from ..utils import recordings


def build_html(session_id: str) -> str:
    db = SessionLocal()
    try:
        s = db.get(ServiceSession, session_id)
        rec = db.query(RecordingSession).filter_by(service_session_id=session_id).first()
        rec_status = recordings.status(rec.expiry_date) if rec else "expired"
        rec_url = recordings.signed_url(rec.id, rec.expiry_date) if (rec and rec_status != "expired") else None
        return f"""
        <html><body>
          <h1>BAYWATCH — Service Completion Report</h1>
          <p>Session: {session_id}</p>
          <h3>Service Recording Information</h3>
          <ul>
            <li>Recording available: {"Yes" if rec_url else "No"}</li>
            <li>Recording Session ID: {rec.id if rec else "-"}</li>
            <li>Duration: {recordings.duration_full(rec.duration_seconds) if rec else "-"}</li>
            <li>Expiry: {recordings.fmt_date(rec.expiry_date) if rec else "-"}</li>
            <li>Status: {rec_status}</li>
            <li>Link: {rec_url or "expired"}</li>
          </ul>
          <p>This recording is available for 14 days from completion.</p>
        </body></html>"""
    finally:
        db.close()


def generate_completion_pdf(session_id: str) -> str | None:
    html = build_html(session_id)
    try:
        from weasyprint import HTML
        from ..utils import storage
        pdf_bytes = HTML(string=html).write_pdf()
        key = f"{session_id}.pdf"
        storage.upload_file("completion-pdfs", key, pdf_bytes, "application/pdf")
        return storage.generate_signed_url("completion-pdfs", key)
    except Exception:
        return None  # dev without weasyprint/minio
