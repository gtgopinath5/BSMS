"""Deterministic, template-aware job-card parser.

The app's *generated* job card uses six numbered sections + a Parts Detail table:

    1. VEHICLE INFORMATION   2. CUSTOMER INFORMATION   3. SERVICE INFORMATION
    4. STAFF & VEHICLE STATUS 5. CUSTOMER VOICE          6. PARTS DETAIL

This parser splits the text by those anchors and extracts each field ONLY inside
its own section (so MODEL never captures REPAIR TYPE and CUSTOMER VOICE never
captures the job-card number). It also extracts the Parts Detail table with the
real column order — S.NO · JOB CODE · PART NAME · PART NUMBER · QTY · UNIT VALUE —
via pdfplumber tables (header-aware) with a line-based regex fallback.

If the document is NOT the numbered template (e.g. a raw dealer Bajaj card), it
falls back to the legacy ``triumph_parser`` so old uploads keep working.

Parts → Parts Time matching + estimate live in ``services.estimate_service`` — this
module only EXTRACTS; it never calculates minutes.
"""
import re

# ── section anchors (numbered template) ────────────────────────────
SECTION_ANCHORS = [
    ("vehicle", r"1\s*[.)]\s*VEHICLE\s+INFORMATION"),
    ("customer", r"2\s*[.)]\s*CUSTOMER\s+INFORMATION"),
    ("service", r"3\s*[.)]\s*SERVICE\s+INFORMATION"),
    ("staff", r"4\s*[.)]\s*STAFF\s*(?:&|AND)\s*VEHICLE\s+STATUS"),
    ("voice", r"5\s*[.)]\s*CUSTOMER\s+VOICE"),
    ("parts", r"6\s*[.)]\s*PARTS\s+DETAIL"),
]

# ordered (label, output_key) per section — anchor-based value extraction
SECTION_LABELS = {
    "vehicle": [("MODEL", "model"), ("REGISTRATION", "registration"),
                ("CHASSIS NO", "chassis_no"), ("ENGINE NO", "engine_no"),
                ("DATE OF SALE", "date_of_sale"), ("KMS COVERED", "kms_covered")],
    "customer": [("NAME", "name"), ("CONTACT", "contact"), ("EMAIL", "email"),
                 ("CUSTOMER ID", "customer_id"), ("KYC STATUS", "kyc_status"),
                 ("ADDRESS", "address")],
    "service": [("JOB CARD NO", "job_card_no"), ("REPAIR TYPE", "repair_type"),
                ("DATE & TIME IN", "date_time_in"), ("EST. DELIVERY", "estimated_delivery"),
                ("EST. COST", "estimated_cost"), ("CARD DATE", "card_date")],
    "staff": [("SERVICE ADVISOR", "service_advisor"), ("SA CONTACT", "sa_contact"),
              ("TECHNICIAN", "technician"), ("PETROL LEVEL", "petrol_level"),
              ("LAST VISIT", "last_visit")],
}

# numbered → flat legacy keys (keeps the existing extraction modal working)
_FLAT = {
    "vehicle.model": "model", "vehicle.registration": "vehicle_number",
    "vehicle.chassis_no": "chassis_number", "vehicle.engine_no": "engine_number",
    "vehicle.kms_covered": "km_reading", "vehicle.date_of_sale": "date_of_sale",
    "customer.name": "customer_name", "customer.contact": "customer_mobile",
    "customer.email": "customer_email", "customer.customer_id": "customer_id",
    "customer.kyc_status": "kyc_status", "customer.address": "customer_address",
    "service.job_card_no": "job_card_number", "service.repair_type": "repair_type",
    "service.date_time_in": "date_time_in", "service.estimated_delivery": "estimated_delivery",
    "service.estimated_cost": "estimated_cost", "service.card_date": "date",
    "staff.service_advisor": "sa_name", "staff.sa_contact": "sa_contact",
    "staff.technician": "technician_name", "staff.petrol_level": "petrol_level",
}

# a Parts Detail data row: S.NO  JOB-CODE  PART NAME…  PART-NUMBER  QTY  UNIT-VALUE
_PART_ROW = re.compile(
    r"^\s*(\d{1,3})\s+([A-Z]{1,4}\d{1,4})\s+([A-Z0-9][A-Z0-9 ./\-]+?)\s+"
    r"([0-9A-Z]{5,16})\s+(\d{1,3})\s+(\d{1,5})\s*$"
)
_HEADER_KEYS = ("s.no", "job code", "part name", "part number", "qty", "unit value")

# a real bike part number is alphanumeric with at least one letter (e.g. 36TA0161,
# TA141014). Used to detect when pdfplumber's *table* split mis-mapped the columns
# (gluing s_no/job_code into the name and garbling the number).
_PN_OK = re.compile(r"^[0-9A-Z]{5,16}$")
_NAME_PREFIX = re.compile(r"^\s*\d{1,3}\s+[A-Z]{1,4}\d{1,4}\s+")   # leading "1 TA40 "


def _clean_part_name(name):
    return re.sub(r"\s+", " ", _NAME_PREFIX.sub("", name or "")).strip() or None


def _row_ok(r):
    pn = (r.get("part_number") or "").strip().upper()
    name = (r.get("part_name") or "").strip()
    return bool(_PN_OK.fullmatch(pn)) and bool(re.search(r"[A-Z]", pn)) and not _NAME_PREFIX.match(name)


def _best_parts(*candidates):
    """Pick the candidate rowset with the most clean (validatable) part rows;
    tie-break by row count. Then strip any s_no/job_code glued into the name."""
    cand = [c for c in candidates if c]
    if not cand:
        return []
    rows = max(cand, key=lambda rs: (sum(1 for r in rs if _row_ok(r)), len(rs)))
    for r in rows:
        r["part_name"] = _clean_part_name(r.get("part_name"))
    return rows


def _looks_corrupt(parts) -> bool:
    """True if any extracted row still shows the table-merge corruption signature
    (part number with spaces / over length, or a name that begins '<n> TA<code>')."""
    for p in (parts or []):
        num = (p.get("part_number") or "")
        if " " in num or len(num) > 16:
            return True
        if _NAME_PREFIX.match(p.get("part_name") or ""):
            return True
    return False


# ── pdf read (text + tables) ───────────────────────────────────────
def _read_pdf(data: bytes):
    import io
    text, tables = "", []
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            parts_text = []
            for page in pdf.pages:
                parts_text.append(page.extract_text() or "")
                for tb in (page.extract_tables() or []):
                    tables.append(tb)
            text = "\n".join(parts_text)
    except Exception:
        pass
    return text, tables


# ── section helpers ────────────────────────────────────────────────
def _split_sections(text: str):
    marks = []
    for name, pat in SECTION_ANCHORS:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            marks.append((m.start(), m.end(), name))
    marks.sort()
    sections = {}
    for i, (_s, end, name) in enumerate(marks):
        nxt = marks[i + 1][0] if i + 1 < len(marks) else len(text)
        sections[name] = text[end:nxt]
    return sections, len(marks)


def _clean(v):
    if v is None:
        return None
    v = re.sub(r"\s+", " ", v).strip().strip(":").strip("-").strip()
    return v or None


def _extract_section_fields(blob: str, labels) -> dict:
    """Anchor-based: find each known label, take the text up to the NEXT label as
    its value. Handles multi-word values + two-labels-per-line layouts."""
    found = []
    for label, key in labels:
        m = re.search(r"(?<![A-Za-z0-9])" + re.escape(label) + r"(?![A-Za-z0-9])",
                      blob, re.IGNORECASE)
        if m:
            found.append((m.start(), m.end(), key))
    found.sort()
    out = {}
    for i, (_s, end, key) in enumerate(found):
        nxt = found[i + 1][0] if i + 1 < len(found) else len(blob)
        out[key] = _clean(blob[end:nxt])
    return out


# ── parts table extraction ─────────────────────────────────────────
def _parts_from_tables(tables) -> list:
    """Header-aware: find the table whose header row matches the Parts Detail
    columns and map by header name (never by fixed index)."""
    for tb in tables or []:
        if not tb or len(tb) < 2:
            continue
        header = [str(c or "").strip().lower() for c in tb[0]]
        joined = " ".join(header)
        if "part name" not in joined or "part number" not in joined:
            continue

        def idx(*names):
            for n in names:
                for i, h in enumerate(header):
                    if n in h:
                        return i
            return None
        ci = {"s_no": idx("s.no", "s no", "sno"), "job_code": idx("job code", "code"),
              "part_name": idx("part name", "name"), "part_number": idx("part number", "part no"),
              "qty": idx("qty", "quantity"), "unit_value": idx("unit value", "unit val")}
        if ci["part_name"] is None or ci["part_number"] is None:
            continue
        rows = []
        for r in tb[1:]:
            if not r or not any(r):
                continue

            def g(key):
                i = ci[key]
                return str(r[i]).strip() if (i is not None and i < len(r) and r[i] is not None) else ""
            name, pn = g("part_name"), g("part_number")
            if not name and not pn:
                continue
            rows.append({
                "s_no": _int(g("s_no"), len(rows) + 1), "job_code": g("job_code") or None,
                "part_name": name, "part_number": pn or None,
                "qty": _int(g("qty"), 1), "unit_value": _num(g("unit_value")),
            })
        if rows:
            return rows
    return []


def _parts_from_text(parts_blob: str) -> list:
    rows = []
    for line in (parts_blob or "").splitlines():
        s = line.strip()
        if not s or s.lower().replace("·", " ").startswith("s.no"):
            continue
        if any(k in s.lower() for k in ("customer signature", "service advisor", "technician")):
            break
        m = _PART_ROW.match(s)
        if m:
            rows.append({
                "s_no": _int(m.group(1), len(rows) + 1), "job_code": m.group(2),
                "part_name": _clean(m.group(3)), "part_number": m.group(4),
                "qty": _int(m.group(5), 1), "unit_value": _num(m.group(6)),
            })
    return rows


# ── Parts Detail WITH dealership costs (Service / Labour / Total) ───
# A cost data row is a single text line:
#   "1 TA40 KIT CHAIN SPROCKET 36TA0161 1 4 ₹ 2,450 ₹ 500 ₹ 2,950"
# The numeric tail (qty, unit-value, 3 costs) anchors the split, so the lazy name
# group can never swallow the part number. Some rows wrap (the name renders on the
# line(s) above/below an otherwise name-less data line) — those are reconstructed
# from adjacent bare fragments.
_COST_ROW = re.compile(
    r"^\s*(\d{1,3})\s+([A-Z]{1,4}\d{1,4})\s+(.*?)\s*([0-9A-Z]{5,16})\s+(\d{1,3})\s+(\d{1,6})\s+"
    r"₹?\s*([\d,]+)\s+₹?\s*([\d,]+)\s+₹?\s*([\d,]+)\s*$"
)
_UNIT_ROW = _PART_ROW                                   # cost-less fallback (up to unit value)
_TOTAL_ROW = re.compile(r"^\s*TOTAL\s+₹?\s*([\d,]+)\s+₹?\s*([\d,]+)\s+₹?\s*([\d,]+)\s*$", re.IGNORECASE)
_FRAG = re.compile(r"^[A-Z][A-Z ./&\-]*$")
_FRAG_STOP = re.compile(r"S\.?NO|JOB|CODE|PART|QTY|UNIT|VALUE|SERVICE|LABOUR|TOTAL|COST|SIGNATURE|ADVISOR|TECHNICIAN")


def _is_name_fragment(s: str) -> bool:
    s = (s or "").strip()
    return bool(s) and bool(_FRAG.fullmatch(s)) and not _FRAG_STOP.search(s)


def _parse_cost_parts(blob: str):
    """Extract Parts Detail rows WITH costs (and the grand-total row) from the parts
    section text. Returns (rows, totals). Rows carry service/labour/total/unit_value +
    has_missing_cost; cost-less PDFs fall through to unit-value rows flagged missing."""
    lines = [ln.rstrip() for ln in (blob or "").splitlines()]
    parsed = []          # (line_index, row_dict, has_inline_name)
    totals: dict = {}
    for i, s in enumerate(lines):
        s = s.strip()
        mt = _TOTAL_ROW.match(s)
        if mt:
            totals = {"service_cost_total": _num(mt.group(1)), "labour_cost_total": _num(mt.group(2)),
                      "grand_total": _num(mt.group(3))}
            continue
        m = _COST_ROW.match(s)
        if m:
            name = _clean(m.group(3)) or ""
            parsed.append((i, {
                "s_no": _int(m.group(1), len(parsed) + 1), "job_code": m.group(2),
                "part_name": name, "part_number": m.group(4),
                "qty": _int(m.group(5), 1), "unit_value": _num(m.group(6)),
                "service_cost": _num(m.group(7)), "labour_cost": _num(m.group(8)),
                "total_cost": _num(m.group(9)),
            }, bool(name)))
            continue
        m = _UNIT_ROW.match(s)
        if m:
            name = _clean(m.group(3)) or ""
            parsed.append((i, {
                "s_no": _int(m.group(1), len(parsed) + 1), "job_code": m.group(2),
                "part_name": name, "part_number": m.group(4),
                "qty": _int(m.group(5), 1), "unit_value": _num(m.group(6)),
                "service_cost": None, "labour_cost": None, "total_cost": None,
            }, bool(name)))
    rows = []
    for i, row, has_name in parsed:
        if not has_name:                                 # reconstruct a wrapped name
            pre, j = [], i - 1
            while j >= 0 and _is_name_fragment(lines[j]):
                pre.insert(0, lines[j].strip()); j -= 1
            post, k = [], i + 1
            while k < len(lines) and _is_name_fragment(lines[k]):
                post.append(lines[k].strip()); k += 1
            row["part_name"] = _clean(" ".join(pre + post)) or row["part_name"] or None
        row["has_missing_cost"] = row.get("total_cost") is None and \
            row.get("service_cost") is None and row.get("labour_cost") is None
        rows.append(row)
    return rows, totals


def _cost_warnings(rows, totals) -> list:
    """Non-mutating sanity checks (display only): per-row total ≈ service+labour, and
    grand total ≈ Σ row totals. The PDF's own values are NEVER changed."""
    warns = []
    for r in rows:
        sc, lc, tc = r.get("service_cost"), r.get("labour_cost"), r.get("total_cost")
        if tc is not None and sc is not None and lc is not None and abs((sc + lc) - tc) > 1.0:
            warns.append(f"Row {r.get('s_no')}: total ₹{tc:,.0f} ≠ service ₹{sc:,.0f} + labour ₹{lc:,.0f}")
    if totals.get("grand_total") is not None:
        row_sum = sum(r["total_cost"] for r in rows if r.get("total_cost") is not None)
        if row_sum and abs(row_sum - totals["grand_total"]) > 1.0:
            warns.append(f"Grand total ₹{totals['grand_total']:,.0f} ≠ Σ row totals ₹{row_sum:,.0f}")
    return warns


# ── numbered-template parse ────────────────────────────────────────
def _parse_numbered(text: str, sections: dict, tables) -> dict:
    vehicle = _extract_section_fields(sections.get("vehicle", ""), SECTION_LABELS["vehicle"])
    customer = _extract_section_fields(sections.get("customer", ""), SECTION_LABELS["customer"])
    service = _extract_section_fields(sections.get("service", ""), SECTION_LABELS["service"])
    staff = _extract_section_fields(sections.get("staff", ""), SECTION_LABELS["staff"])
    voice = _clean(sections.get("voice", "")) or None

    # The bordered real-PDF table can mis-split columns (s_no/job_code glued into
    # the name, garbled number); the line-regex path is deterministic. Run both and
    # keep whichever yields more clean part rows (tie → regex), then clean names.
    legacy_parts = _best_parts(_parts_from_text(sections.get("parts", "")), _parts_from_tables(tables))
    # cost-aware path: extracts Service/Labour/Total + handles wrapped names. Runs on the
    # FULL text (the section blob can clip wrapped rows); the numeric/₹ anchors make the
    # row + TOTAL regexes specific enough that no non-parts line matches. Prefer it when it
    # finds at least as many rows (it also carries costs the legacy path lacks).
    cost_parts, cost_totals = _parse_cost_parts(text)
    _has_costs = any(p.get("total_cost") is not None or p.get("service_cost") is not None for p in cost_parts)
    # prefer the cost path when it found real costs, or when it cleanly matched at least as
    # many rows as the legacy/table path (which can include a stray TOTAL row, mis-split).
    if cost_parts and (_has_costs or len(cost_parts) >= len(legacy_parts)):
        parts = cost_parts
    else:
        parts, cost_totals = legacy_parts, {}
    cost_warnings = _cost_warnings(parts, cost_totals)

    # estimated_cost: keep numeric text (strip ₹/Rs)
    if service.get("estimated_cost"):
        c = re.sub(r"[^\d.]", "", service["estimated_cost"])
        service["estimated_cost"] = c or service["estimated_cost"]

    structured = {"vehicle": vehicle, "customer": customer, "service": service,
                  "staff_status": staff, "customer_voice": voice, "parts": parts,
                  "cost_totals": cost_totals, "cost_warnings": cost_warnings}

    # flat legacy keys for the existing modal
    flat = {}
    src = {"vehicle": vehicle, "customer": customer, "service": service, "staff": staff}
    for dotted, key in _FLAT.items():
        sec, fld = dotted.split(".")
        val = src.get(sec, {}).get(fld)
        if val:
            flat[key] = val
    if voice:
        flat["customer_voice"] = voice

    # confidence: share of the core fields actually found
    core = ["model", "vehicle_number", "chassis_number", "engine_number",
            "customer_name", "customer_mobile", "job_card_number", "repair_type"]
    conf = round(sum(1 for k in core if flat.get(k)) / len(core), 2)
    valid = bool(flat.get("job_card_number") or flat.get("model"))

    return {"valid": valid, "template": "numbered", "confidence": conf,
            "score": int(conf * 100), "fields": flat,
            "parts_corrupted": _looks_corrupt(parts), **structured}


def _from_legacy(leg: dict) -> dict:
    """Adapt the legacy triumph_parser result into this module's shape."""
    fields = leg.get("fields", {}) or {}
    return {
        "valid": bool(leg.get("valid")), "template": "legacy",
        "confidence": round((leg.get("score") or 0) / 100, 2), "score": leg.get("score", 0),
        "fields": fields, "customer_voice": fields.get("customer_voice"),
        "vehicle": {}, "customer": {}, "service": {}, "staff_status": {},
        "parts": [],  # legacy dealer card is service-based; no parts table
        "missing_keywords": leg.get("missing_keywords", []),
    }


# ── public API ─────────────────────────────────────────────────────
def parse_text(text: str, tables=None) -> dict:
    sections, n = _split_sections(text or "")
    if n >= 4:
        return _parse_numbered(text, sections, tables)
    from . import triumph_parser
    return _from_legacy(triumph_parser.extract(text or ""))


def parse(data: bytes) -> dict:
    text, tables = _read_pdf(data)
    return parse_text(text, tables)


# ── small coercers ─────────────────────────────────────────────────
def _int(v, default=0):
    try:
        return int(re.sub(r"[^\d-]", "", str(v)) or default)
    except Exception:
        return default


def _num(v):
    try:
        return float(re.sub(r"[^\d.]", "", str(v)) or 0)
    except Exception:
        return 0.0
