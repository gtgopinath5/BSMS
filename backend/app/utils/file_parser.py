"""Parse parts catalogs from Excel or PDF into normalized rows:
    { product_code, part_number, part_name, unit_value, unit_time }
Heavy libs are imported lazily so the API boots without them.
"""


def parse_excel(file_bytes: bytes) -> list[dict]:
    import io
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(file_bytes), read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    header = [str(h or "").strip().lower() for h in rows[0]]

    def col(*names):
        for n in names:
            if n in header:
                return header.index(n)
        return None

    ci = {
        "product_code": col("product code", "product_code", "code"),
        "part_number": col("part number", "part_no", "part_number"),
        "part_name": col("part name", "description", "name"),
        "unit_value": col("unit value", "value", "qty"),
        "unit_time": col("unit time", "time"),
    }
    out = []
    for r in rows[1:]:
        if not any(r):
            continue
        def get(key, default=""):
            i = ci[key]
            return r[i] if i is not None and i < len(r) and r[i] is not None else default
        out.append({
            "product_code": str(get("product_code")).strip() or None,
            "part_number": str(get("part_number")).strip() or None,
            "part_name": str(get("part_name")).strip(),
            "unit_value": float(get("unit_value", 0) or 0),
            "unit_time": float(get("unit_time", 0) or 0),
        })
    return out


def parse_pdf_parts(file_bytes: bytes) -> list[dict]:
    """Text-based PDFs via pdfplumber; scanned pages fall back to OCR."""
    import io
    rows: list[dict] = []
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
            for page in pdf.pages:
                for table in (page.extract_tables() or []):
                    for r in table[1:]:
                        if r and r[0]:
                            rows.append({
                                "product_code": (r[0] or "").strip() or None,
                                "part_number": (r[1] if len(r) > 1 else "") or None,
                                "part_name": (r[2] if len(r) > 2 else "") or "",
                                "unit_value": _num(r[3] if len(r) > 3 else 0),
                                "unit_time": _num(r[4] if len(r) > 4 else 0),
                            })
    except Exception:
        pass
    return rows


def extract_part_numbers_from_job_card(file_bytes: bytes, filename: str = "") -> list[str]:
    """Extract part numbers from a job card document.
    A job card lists part numbers with quantities; we care only about the identifiers."""
    import re
    found: set[str] = set()
    is_excel = filename.lower().endswith((".xlsx", ".xls"))

    if is_excel:
        for r in parse_excel(file_bytes):
            for key in ("part_number", "product_code"):
                v = r.get(key)
                if v and _looks_like_part_number(str(v)):
                    found.add(str(v).strip())
    else:
        try:
            import io, pdfplumber
            with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
                for page in pdf.pages:
                    for table in (page.extract_tables() or []):
                        for row in table:
                            for cell in (row or [])[:4]:
                                s = str(cell or "").strip()
                                if _looks_like_part_number(s):
                                    found.add(s)
                    text = page.extract_text() or ""
                    for m in re.finditer(r'\b([A-Z][A-Z0-9\-_/]{3,14})\b', text):
                        if _looks_like_part_number(m.group(1)):
                            found.add(m.group(1))
        except Exception:
            pass

    return list(found)


def _looks_like_part_number(s: str) -> bool:
    import re
    if not s or len(s) < 4 or len(s) > 16:
        return False
    return bool(re.search(r'[A-Z]', s)) and bool(re.search(r'[0-9]', s)) and bool(re.match(r'^[A-Z0-9\-_/]+$', s))


def _num(v) -> float:
    try:
        return float(str(v).replace(",", "").strip() or 0)
    except Exception:
        return 0.0
