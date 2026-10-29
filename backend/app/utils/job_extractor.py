"""Extract + validate a service job-card PDF, and match its parts to the
parts master. Heavy libs imported lazily.
"""
KEYWORDS = ["job card", "chassis", "engine no", "registration", "technician",
            "service advisor", "vehicle", "customer"]


def extract_text(pdf_bytes: bytes) -> str:
    import io
    try:
        import pdfplumber
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            return "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception:
        return ""


def validate_job_card(text: str) -> dict:
    low = text.lower()
    found = [k for k in KEYWORDS if k in low]
    missing = [k for k in KEYWORDS if k not in low]
    score = int(len(found) / len(KEYWORDS) * 100)
    return {"valid": score >= 50, "score": score, "found_keywords": found, "missing_keywords": missing}


def extract_fields(text: str) -> dict:
    """Best-effort labelled-field + regex extraction. Every value is editable
    on the review screen, so partial extraction is fine."""
    import re
    f: dict = {}

    def grab(*patterns):
        for pat in patterns:
            m = re.search(pat, text, re.IGNORECASE)
            if m:
                v = m.group(1).strip().strip(":-").strip()
                if v:
                    return v
        return None

    # Vehicle
    f["vehicle_number"] = grab(r'(?:reg(?:istration)?\.?\s*(?:no\.?|number)?|vehicle\s*no\.?)\s*[:\-]?\s*([A-Z]{2}[\s\-]?\d{1,2}[\s\-]?[A-Z]{0,3}[\s\-]?\d{3,4})',
                               r'\b([A-Z]{2}\s?\d{2}\s?[A-Z]{1,2}\s?\d{4})\b')
    f["vehicle_model"] = grab(r'(?:model|vehicle\s*model|make\s*&?\s*model)\s*[:\-]\s*([A-Za-z0-9 .\-]{2,40})')
    f["chassis_number"] = grab(r'(?:chassis\s*(?:no\.?|number)?|vin)\s*[:\-]?\s*([A-Z0-9]{6,20})')
    f["engine_number"] = grab(r'engine\s*(?:no\.?|number)?\s*[:\-]?\s*([A-Z0-9]{5,20})')
    f["km_reading"] = grab(r'(?:k\.?m\.?\s*(?:reading)?|odo(?:meter)?)\s*[:\-]?\s*([\d,]{1,8})')
    # Customer
    f["customer_name"] = grab(r'(?:customer\s*name|cust(?:omer)?|name)\s*[:\-]\s*([A-Za-z .]{2,40})')
    f["customer_mobile"] = grab(r'(?:mobile|phone|contact|cell)\s*(?:no\.?|number)?\s*[:\-]?\s*(\+?\d[\d\s\-]{8,14})')
    f["customer_email"] = grab(r'\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b')
    f["customer_address"] = grab(r'address\s*[:\-]\s*([A-Za-z0-9 ,.\-/]{5,80})')
    # Service
    f["job_card_number"] = grab(r'(?:job\s*card|jc)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9\-]{3,20})')
    f["service_type"] = grab(r'service\s*type\s*[:\-]\s*([A-Za-z &]{3,40})')
    f["repair_type"] = grab(r'repair\s*type\s*[:\-]\s*([A-Za-z &]{3,40})')
    f["estimated_cost"] = grab(r'(?:est(?:imated)?\.?\s*cost|amount|total)\s*[:\-]?\s*(?:₹|rs\.?)?\s*([\d,]{2,10})')
    # Customer voice
    f["complaint"] = grab(r'(?:complaint|customer\s*voice|problem|issue)\s*[:\-]\s*([A-Za-z0-9 ,.\-/()]{4,120})')

    return {k: v for k, v in f.items() if v}


def extract_job_card(pdf_bytes: bytes) -> dict:
    """Returns extracted fields + a confidence score. Fields are best-effort
    regex parses; all are editable on the review screen before saving."""
    text = extract_text(pdf_bytes)
    validation = validate_job_card(text)
    return {"fields": extract_fields(text), "raw_text_len": len(text), **validation}


def match_parts(part_numbers: list[str], db) -> list[dict]:
    """Match by product_code first, then part_number."""
    from ..models.part import PartsMaster
    from sqlalchemy import select, or_
    matched = []
    for pn in part_numbers:
        row = db.scalar(select(PartsMaster).where(
            or_(PartsMaster.product_code == pn, PartsMaster.part_number == pn)
        ))
        if row:
            matched.append({"part_number": pn, "part_name": row.part_name,
                            "estimated_time": row.estimated_time})
    return matched
