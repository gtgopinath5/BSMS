"""Standalone Vehicle Intake Evidence PDF (Phase E).

A dedicated, server-side evidence report for a single intake entry — **completely separate from
Work Completion** (``lwcBuildCompletionReport`` is never imported or touched). Built with fpdf2
(pure-Python, already installed, no system cairo/pango), so it works in dev and prod identically.

Security contract (mirrors the rest of the intake module):
  • Image pixels are read from disk server-side via ``intake.local_path`` and rendered into the PDF.
    The storage KEY / absolute filesystem path is NEVER written into the document.
  • Voice notes are NOT embedded. Each gets a secure, HMAC-signed, expiry-capped link that routes
    through ``/intake/media/{id}/view`` (``intake.view_url_abs``). Expired / revoked / deleted media
    get a status line instead of a playable link.
"""
import io
import logging
import re
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.branch import Branch
from ..models.vehicle_intake import VehicleIntakeEntry, VehicleIntakeMedia, VehicleIntakeEvent
from . import intake as intake_utils

log = logging.getLogger("baywatch.intake")

# ── palette ─────────────────────────────────────────────────────────
_INK = (17, 24, 39)          # near-black slate (header band, headings)
_ACCENT = (37, 99, 235)      # blue accent
_MUTED = (110, 116, 128)     # labels / secondary text
_LINE = (224, 226, 232)      # hairlines
_BAND = (243, 244, 246)      # section-header fill
_OK = (22, 138, 90)          # active / available
_BAD = (190, 60, 60)         # expired / revoked / deleted

_MARGIN = 12.0
_REPL = {"…": "...", "’": "'", "‘": "'", "“": '"', "”": '"',
         "–": "-", "—": "-", "₹": "Rs ", " ": " ", "•": "-"}
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


def _t(s) -> str:
    """Latin-1-safe text for the core PDF fonts (smart-quote/ellipsis/rupee folded; rest replaced)."""
    if s is None:
        return ""
    s = str(s)
    for k, v in _REPL.items():
        s = s.replace(k, v)
    return s.encode("latin-1", "replace").decode("latin-1")


def _dt(dt: datetime | None) -> str:
    if not dt:
        return "—".encode("latin-1", "replace").decode("latin-1") or "-"
    try:
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(dt)[:16]


def _dur(sec) -> str:
    try:
        sec = int(sec)
    except (TypeError, ValueError):
        return "-"
    if sec <= 0:
        return "-"
    return f"{sec // 60}:{sec % 60:02d}"


def safe_filename(intake_no: str | None, bike_number: str | None) -> str:
    ino = _SAFE_NAME.sub("", (intake_no or "intake")).strip("_-.") or "intake"
    bike = _SAFE_NAME.sub("", (bike_number or "NA")).strip("_-.") or "NA"
    return f"Vehicle_Intake_Evidence_{ino}_{bike}.pdf"


def _media_status(m: VehicleIntakeMedia) -> str:
    """Display status: an active row past its expiry reads 'expired' (mirrors media_out)."""
    if intake_utils.media_expired(m) and m.status == "active":
        return "expired"
    return m.status


def _available(m: VehicleIntakeMedia) -> bool:
    return m.status == "active" and not intake_utils.media_expired(m)


class _IntakePDF:
    """Thin fpdf2 wrapper with a footer (retention notice + page X/N)."""

    def __init__(self, retention_days: int):
        from fpdf import FPDF

        class _PDF(FPDF):
            def footer(self_inner):
                self_inner.set_y(-16)
                self_inner.set_draw_color(*_LINE)
                self_inner.line(_MARGIN, self_inner.get_y(), 210 - _MARGIN, self_inner.get_y())
                self_inner.set_y(-13.5)
                self_inner.set_font("Helvetica", "I", 7)
                self_inner.set_text_color(*_MUTED)
                self_inner.multi_cell(
                    0, 3.4,
                    _t("This report is generated from intake evidence captured before service work.\n"
                       f"Images and voice evidence are temporary and follow {retention_days}-day retention."),
                    align="C")
                self_inner.set_y(-6.5)
                self_inner.set_font("Helvetica", "", 7)
                self_inner.cell(0, 4, f"Page {self_inner.page_no()}/{{nb}}", align="C")

        self.pdf = _PDF(orientation="P", unit="mm", format="A4")
        self.pdf.set_auto_page_break(True, margin=20)
        self.pdf.set_title("Vehicle Intake Evidence Report")
        try:
            self.pdf.alias_nb_pages()
        except Exception:
            pass
        self.pdf.add_page()

    # ── primitives ──────────────────────────────────────────────────
    @property
    def p(self):
        return self.pdf

    def _usable_w(self):
        return 210 - 2 * _MARGIN

    def section(self, title: str):
        p = self.pdf
        if p.get_y() + 16 > p.page_break_trigger:
            p.add_page()
        p.ln(2)
        p.set_fill_color(*_BAND)
        p.set_draw_color(*_LINE)
        p.set_text_color(*_INK)
        p.set_font("Helvetica", "B", 10)
        p.set_x(_MARGIN)
        p.cell(self._usable_w(), 7.6, _t("  " + title), border=0, fill=True,
               new_x="LMARGIN", new_y="NEXT")
        p.ln(1.5)

    def field(self, label: str, value, full=True):
        p = self.pdf
        p.set_x(_MARGIN)
        p.set_font("Helvetica", "", 8.5)
        p.set_text_color(*_MUTED)
        p.cell(40, 5.6, _t(label), border=0)
        p.set_text_color(25, 28, 34)
        p.set_font("Helvetica", "", 9.5)
        val = value if (value is not None and str(value).strip() != "") else "—"
        p.multi_cell(self._usable_w() - 40, 5.6, _t(val))

    def note(self, text: str, color=_MUTED, size=8.5, italic=False):
        p = self.pdf
        p.set_x(_MARGIN)
        p.set_font("Helvetica", "I" if italic else "", size)
        p.set_text_color(*color)
        p.multi_cell(self._usable_w(), 4.8, _t(text))


def _header(doc: _IntakePDF, e: VehicleIntakeEntry, branch_name: str | None):
    p = doc.p
    # dark title band
    p.set_fill_color(*_INK)
    p.rect(0, 0, 210, 30, style="F")
    p.set_xy(_MARGIN, 7)
    p.set_text_color(255, 255, 255)
    p.set_font("Helvetica", "B", 16)
    p.cell(0, 8, _t("Vehicle Intake Evidence Report"), new_x="LMARGIN", new_y="NEXT")
    p.set_x(_MARGIN)
    p.set_font("Helvetica", "", 9)
    p.set_text_color(195, 200, 210)
    gen = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    p.cell(0, 5, _t(f"{e.intake_no}   ·   Status: {(e.status or '').upper()}   ·   Generated {gen}"))
    p.set_xy(_MARGIN, 32)
    p.set_text_color(*_INK)

    # quick identity strip
    doc.field("Branch", f"{branch_name or '—'}  ({e.branch_id or '—'})")
    doc.field("Worker", f"{e.worker_name or '—'}  ({e.worker_id or '—'})")
    doc.field("Submitted", _dt(e.submitted_at))
    doc.field("Retention expiry", _dt(e.expires_at))


def _vehicle_customer(doc: _IntakePDF, e: VehicleIntakeEntry):
    doc.section("Vehicle details")
    doc.field("Bike / Reg. number", e.bike_number_raw)
    doc.field("Normalized number", e.bike_number_normalized)
    doc.field("Engine number", e.engine_number)
    doc.field("Chassis number", e.chassis_number)

    doc.section("Customer details")
    doc.field("Customer name", e.customer_name)
    doc.field("Phone", e.phone_number)
    doc.field("WhatsApp", e.whatsapp_number)
    doc.field("Email", e.email)
    doc.field("Address", e.address)

    doc.section("Complaint")
    doc.note(e.complaint_description or "—", color=(25, 28, 34), size=9.5)


def _link_status(doc: _IntakePDF, e: VehicleIntakeEntry):
    doc.section("Link status")
    is_linked = bool(e.linked_job_card_id or e.linked_job_id or e.linked_assignment_id)
    if not is_linked:
        doc.note("Not linked to any job card yet.", italic=True)
        return
    doc.field("Linked job id", e.linked_job_id)
    doc.field("Linked job card id", e.linked_job_card_id)
    doc.field("Linked assignment id", e.linked_assignment_id)
    doc.field("Linked by admin", e.linked_by_admin_name or e.linked_by_admin_id)
    doc.field("Linked at", _dt(e.linked_at))


def _images(doc: _IntakePDF, images: list[VehicleIntakeMedia]):
    doc.section(f"Bike condition images ({len(images)})")
    p = doc.p
    if not images:
        doc.note("No bike-condition images were captured for this intake.", italic=True)
        return

    cols = 3
    gap = 6.0
    usable = doc._usable_w()
    col_w = (usable - gap * (cols - 1)) / cols
    box_h = 38.0
    cap_h = 16.0           # caption + time + status block
    cell_h = box_h + cap_h + 3

    for i, m in enumerate(images):
        col = i % cols
        if col == 0:
            if p.get_y() + cell_h > p.page_break_trigger:
                p.add_page()
            row_y = p.get_y()
        x = _MARGIN + col * (col_w + gap)
        _image_cell(doc, m, x, row_y, col_w, box_h)
        # caption / meta under the image
        p.set_xy(x, row_y + box_h + 1.5)
        p.set_font("Helvetica", "", 7.5)
        p.set_text_color(25, 28, 34)
        p.multi_cell(col_w, 3.4, _t((m.caption or "No caption")[:60]), align="L")
        p.set_x(x)
        p.set_font("Helvetica", "", 7)
        p.set_text_color(*_MUTED)
        p.cell(col_w, 3.2, _t(_dt(m.created_at)), new_x="LMARGIN", new_y="NEXT")
        p.set_x(x)
        st = _media_status(m)
        p.set_text_color(*(_OK if st == "active" else _BAD))
        p.cell(col_w, 3.2, _t(f"Status: {st}"))
        if col == cols - 1:
            p.set_xy(_MARGIN, row_y + cell_h)
    # ensure we drop below the last partial row
    last_col = (len(images) - 1) % cols
    if last_col != cols - 1:
        p.set_xy(_MARGIN, row_y + cell_h)


def _image_cell(doc: _IntakePDF, m: VehicleIntakeMedia, x: float, y: float, w: float, h: float):
    p = doc.p
    p.set_draw_color(*_LINE)
    p.rect(x, y, w, h, style="D")
    placeholder = None
    if not _available(m):
        placeholder = f"Image {_media_status(m)}"
    else:
        key = m.thumbnail_path or m.file_path
        path = intake_utils.local_path(key)        # server-side internal access only
        if not path:
            placeholder = "Image unavailable"
        else:
            try:
                from PIL import Image, ImageOps
                im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
                iw, ih = im.size
                scale = min((w - 2) / iw, (h - 2) / ih)
                dw, dh = iw * scale, ih * scale
                ox, oy = x + (w - dw) / 2, y + (h - dh) / 2
                buf = io.BytesIO()
                im.save(buf, "JPEG", quality=82)
                buf.seek(0)
                p.image(buf, x=ox, y=oy, w=dw, h=dh)
            except Exception:
                log.warning("intake-pdf: could not embed image %s", m.id, exc_info=True)
                placeholder = "Image render failed"
    if placeholder:
        p.set_xy(x, y + h / 2 - 3)
        p.set_font("Helvetica", "I", 7.5)
        p.set_text_color(*_MUTED)
        p.cell(w, 6, _t(placeholder), align="C")


def _voices(doc: _IntakePDF, voices: list[VehicleIntakeMedia]):
    doc.section(f"Voice recordings ({len(voices)})")
    p = doc.p
    if not voices:
        doc.note("No complaint voice notes were captured for this intake.", italic=True)
        return
    doc.note("Audio is not embedded. Use the secure expiring link to play each note; "
             "links respect the 14-day retention and stop working at expiry.", italic=True)
    p.ln(1)
    for idx, m in enumerate(voices, 1):
        if p.get_y() + 18 > p.page_break_trigger:
            p.add_page()
        st = _media_status(m)
        p.set_x(_MARGIN)
        p.set_font("Helvetica", "B", 9)
        p.set_text_color(*_INK)
        label = (m.caption or f"Voice note {idx}")
        p.cell(0, 5, _t(f"{idx}.  {label}"), new_x="LMARGIN", new_y="NEXT")
        p.set_x(_MARGIN + 6)
        p.set_font("Helvetica", "", 8)
        p.set_text_color(*_MUTED)
        p.cell(0, 4.4, _t(f"Duration {_dur(m.duration_seconds)}   ·   Recorded {_dt(m.created_at)}"
                          f"   ·   Expires {_dt(m.expires_at)}"))
        p.ln(4.4)
        p.set_x(_MARGIN + 6)
        if _available(m):
            link = intake_utils.view_url_abs(m.id, m.expires_at, "view")
            p.set_font("Helvetica", "", 7.5)
            p.set_text_color(*_ACCENT)
            p.cell(34, 4.4, _t("Secure playback link:"))
            p.set_x(_MARGIN + 40)
            p.multi_cell(doc._usable_w() - 40, 4.4, _t(link), link=link)
        else:
            p.set_font("Helvetica", "I", 8)
            p.set_text_color(*_BAD)
            p.cell(0, 4.4, _t(f"Playback link unavailable - media {st}."), new_x="LMARGIN", new_y="NEXT")
        p.ln(2)


def _timeline(doc: _IntakePDF, events: list[VehicleIntakeEvent]):
    doc.section("Audit / event timeline")
    p = doc.p
    if not events:
        doc.note("No audit events recorded.", italic=True)
        return
    for ev in events:
        if p.get_y() + 8 > p.page_break_trigger:
            p.add_page()
        p.set_x(_MARGIN)
        p.set_font("Helvetica", "", 7.5)
        p.set_text_color(*_MUTED)
        p.cell(34, 4.6, _t(_dt(ev.created_at)))
        p.set_text_color(25, 28, 34)
        p.set_font("Helvetica", "B", 7.5)
        who = ev.actor_name or (ev.actor_type or "")
        p.cell(36, 4.6, _t(f"{who} · {ev.actor_type or ''}"))
        p.set_font("Helvetica", "", 7.5)
        msg = ev.message or ev.event_type or ""
        p.multi_cell(doc._usable_w() - 70, 4.6, _t(f"{ev.event_type}: {msg}" if ev.message else msg))


def build_evidence_pdf(db: Session, e: VehicleIntakeEntry) -> bytes:
    """Render the full standalone Vehicle Intake Evidence PDF for one entry. Returns PDF bytes.
    Reads media bytes from disk server-side; never serializes a filesystem path into the document."""
    media = db.scalars(
        select(VehicleIntakeMedia)
        .where(VehicleIntakeMedia.intake_entry_id == e.id)
        .order_by(VehicleIntakeMedia.created_at)
    ).all()
    images = [m for m in media if m.media_type == "image"]
    voices = [m for m in media if m.media_type == "audio"]
    events = db.scalars(
        select(VehicleIntakeEvent)
        .where(VehicleIntakeEvent.intake_entry_id == e.id)
        .order_by(VehicleIntakeEvent.created_at)
    ).all()
    branch = db.get(Branch, e.branch_id) if e.branch_id else None
    branch_name = branch.name if branch else None

    doc = _IntakePDF(intake_utils.retention_days())
    _header(doc, e, branch_name)
    _vehicle_customer(doc, e)
    _link_status(doc, e)
    _images(doc, images)
    _voices(doc, voices)
    _timeline(doc, events)

    out = doc.p.output()
    return bytes(out)
