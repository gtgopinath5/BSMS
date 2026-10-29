"""Template-aware parser for Triumph / Bajaj (Partner) service job cards.

The job card is a text-based PDF, so we extract the text layer with pdfplumber
and pull labelled fields with targeted regexes — far more reliable than OCR for
this predictable, structured format. A scanned fallback can OCR later if needed.
"""
import re

# Keywords that must be present for a document to count as a valid job card.
REQUIRED_KEYWORDS = [
    "job card", "customer name", "chassis no", "engine no",
    "technician name", "repair type", "customer voice",
]

# Customer-Voice phrase → canonical service + default minutes (used when the
# Parts Time DB has no closer match). Order matters: most specific first.
SERVICE_MAP = [
    (["throttle body cleaning", "throttle body", "throttle"], "Throttle Body Service", 15),
    (["engine oil", "oil replace", "oil change", "kgo oil", "oil"], "Engine Oil Service", 15),
    (["chain spray", "chain lube", "chain clean", "chain"], "Chain Maintenance", 10),
    (["brake check", "brake inspection", "brake bleed", "brake"], "Brake Inspection", 20),
    (["general service", "periodic service", "general"], "General Service", 30),
    (["coolant top-up", "coolant topup", "coolant"], "Coolant Top-Up", 10),
    (["indicator change", "indicator replace", "indicator"], "Indicator Service", 10),
    (["petrol flush", "fuel flush", "petrol"], "Fuel System Check", 10),
    (["air filter", "air-filter"], "Air Filter Service", 10),
    (["battery"], "Battery Check", 10),
    (["wash", "polish", "cleaning"], "Wash & Cleaning", 15),
]


def validate(text: str) -> dict:
    low = (text or "").lower()
    found = [k for k in REQUIRED_KEYWORDS if k in low]
    missing = [k for k in REQUIRED_KEYWORDS if k not in low]
    is_triumph = "triumph" in low or "bajaj" in low or "job card" in low
    score = int(len(found) / len(REQUIRED_KEYWORDS) * 100)
    return {
        "valid": len(found) >= 5 and is_triumph,
        "score": score, "found_keywords": found, "missing_keywords": missing,
    }


def _g(text, *patterns, flags=re.IGNORECASE):
    for pat in patterns:
        m = re.search(pat, text, flags)
        if m:
            v = re.sub(r"\s+", " ", m.group(1)).strip().strip(":-").strip()
            if v:
                return v
    return None


def parse_fields(text: str) -> dict:
    t = text or ""
    f = {}

    # ── Job card info ──
    f["job_card_number"] = _g(t, r"Number\s*:\s*([A-Z0-9]{6,})", r"Job Card Number\s*([A-Z0-9]{6,})")
    f["date"] = _g(t, r"Number\s*:\s*\S+\s+Date\s*:\s*(\d{2}-\d{2}-\d{4})", r"\bDate\s*:\s*(\d{2}-\d{2}-\d{4})")
    f["repair_type"] = _g(t, r"Repair Type\s*:\s*([A-Za-z][A-Za-z ]+?)\s*(?:Reg No|Date|\n)")
    f["date_time_in"] = _g(t, r"Date & Time In\s*:?\s*(\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)")
    f["expected_start"] = _g(t, r"Expected Start Time\s*:?\s*(\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)")
    f["estimated_delivery"] = _g(t, r"Estimated Delivery[\s\S]{0,60}?(\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}\s*[AP]M)")
    f["estimated_cost"] = _g(t, r"Estimated Cost\s*:\s*([\d.,]+)")

    # ── Vehicle info ──
    f["model"] = _g(t, r"Model\s*:\s*([A-Z0-9][A-Z0-9 .\-]+?)\s+Repair Type", r"Model\s*:?\s*([A-Z0-9][A-Z0-9 .\-]{2,30})")
    f["vehicle_number"] = _g(t, r"Reg No\.?\s*:\s*([A-Z0-9]{6,12})")
    f["chassis_number"] = _g(t, r"Chassis No\.?\s*:\s*([A-Z0-9]{10,20})")
    f["engine_number"] = _g(t, r"Engine No\.?\s*:?\s*([A-Z0-9]{6,20})")
    f["date_of_sale"] = _g(t, r"Date of Sale\s*:\s*(\d{2}-\d{2}-\d{4})")
    f["km_reading"] = _g(t, r"Kms?\s*Covered\s*:\s*([\d,]+)")

    # ── Customer info ──
    f["customer_name"] = _g(t, r"Customer Name\s*:\s*([A-Za-z][A-Za-z .]+?)\s+Contact No")
    f["customer_mobile"] = _g(t, r"Contact No\.?\s*:\s*(\+?\d[\d ]{8,13})")
    # anchor to the customer line (Contact No … E-Mail :) so we don't grab the dealer header email
    f["customer_email"] = _g(
        t,
        r"Contact No\.?\s*:\s*\+?[\d ]{8,13}\s*E-?Mail\s*:\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})",
        r"Customer Name[\s\S]{0,80}?E-?Mail\s*:\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})",
    )
    f["customer_id"] = _g(t, r"\((CUS-?\d+)\)")
    f["kyc_status"] = _g(t, r"KYC Status\s*:\s*(\w+)")

    # address — capture the blob after "Address :" up to "Chassis No", then keep
    # the part after the (duplicated) email, which is the real postal address.
    m = re.search(r"Address\s*:\s*([\s\S]+?)\s*Chassis No", t, re.IGNORECASE)
    if m:
        blob = re.sub(r"\s+", " ", m.group(1)).strip()
        tail = re.search(r"@\S+\.\w+\s+(.+)$", blob)
        addr = tail.group(1) if tail else blob
        addr = re.sub(r"\[State Code\s*:\s*\d+\]", "", addr).strip()
        f["customer_address"] = addr

    # ── Staff info (stop at the next label so we don't swallow it) ──
    f["sa_name"] = _g(t, r"SA Name(?:\s*&\s*Sign)?\s*:?\s+([A-Z][A-Z ]+?)\s*(?:\n|Technician|F\.?I|SA Contact|Contact)")
    f["sa_contact"] = _g(t, r"SA Contact Number\s*:?\s*(\d{10})")
    f["technician_name"] = _g(t, r"Technician Name\s*:?\s+([A-Z][A-Z ]+?)\s*(?:\n|F\.?I|SA Contact|SA Name|Working|$)")
    f["petrol_level"] = _g(t, r"Level of Petrol\s*:?\s*(\d+)")

    # last two visits: (date, km, technician)
    visits = []
    for mm in re.finditer(r"(\d{2}-\d{2}-\d{4})\s+(\d{4,6})\s+([A-Z]+(?:\s+[A-Z]+){0,2})", t):
        visits.append({"date": mm.group(1), "km": mm.group(2), "technician": mm.group(3).strip()})
        if len(visits) >= 2:
            break
    f["last_two_visits"] = visits or None

    # ── Customer voice (free text) ──
    mv = re.search(r"Customer Voice[^:]*:\s*([\s\S]+?)(?:\bHEX File\b|\bReception Report\b|\n\n|$)", t, re.IGNORECASE)
    if mv:
        f["customer_voice"] = re.sub(r"\s+", " ", mv.group(1)).strip()

    return {k: v for k, v in f.items() if v not in (None, "", [])}


def map_services(voice: str) -> list[dict]:
    """Parse the Customer Voice free text into canonical services (deduped).
    Matched phrases are consumed so a generic keyword (e.g. "cleaning") can't
    re-trigger on text already claimed by a more specific phrase
    (e.g. "throttle body cleaning")."""
    remaining = (voice or "").lower()
    out, seen = [], set()
    for phrases, service, minutes in SERVICE_MAP:
        for ph in phrases:
            if ph in remaining and service not in seen:
                seen.add(service)
                remaining = remaining.replace(ph, " ")   # consume the matched span
                out.append({"matched_phrase": ph, "service": service, "default_minutes": minutes})
                break
    return out


def extract(text: str) -> dict:
    """Validate + parse + map services. Matching against Parts Time happens in
    the router (needs DB)."""
    v = validate(text)
    if not v["valid"]:
        return {"valid": False, **v, "fields": {}, "services": []}
    fields = parse_fields(text)
    services = map_services(fields.get("customer_voice", ""))
    return {"valid": True, **v, "fields": fields, "services": services}


# ── quick self-test ────────────────────────────────────────────────
if __name__ == "__main__":
    SAMPLE = """Number : PBRJC10000202600001 Date : 06-04-2026
JOB CARD
DEMO MOTORS PRIVATE LIMITED (10000)
Pondicherry 605004Mobile : 9000000001 Email : DEMO_MOTORS_GM@example.com
Model : SPEED 400 UG Repair Type : Second free service
Reg No. : PY05XX0000 Date & Time In : 06-04-2026 03:45 PM
Customer Name : SAMPLE CUSTOMER Contact No. : 9000000002 E-Mail : sample.customer@example.com
Address : SAMPLE CUSTOMER(CUS-1000000)KYC Status: verified Mobile : 9000000002 Email : sample.customer@example.com 1/234 SAMPLE KOVIL STREETDEMO NAGAR GINGEE VILUPPURAMViluppuram 604201Tamil Nadu [State Code : 33] INDIA
Chassis No. : MD2B41MX4SNL00000 Engine No : TAXNSL00000 Date of Sale : 05-04-2025 Kms Covered : 11383
CUSTOMER REQUEST FS 1 2 3 U/W PS Paid Job QRC REPEAT ACCIDENT MISC.
Customer Voice (as explained by customer) : Kgo oil replace chain spray brake check general service coolant top-up petrol flush top-up bottle rear both indicator change throttle body cleaning running time off
HEX File to be Updated
Estimated Delivery Date & Time : 07-04-2026 05:45 PM
Estimated Cost : 0.02
SA Name & Sign SAMPLE ADVISOR
Technician Name SAMPLE TECHNICIAN  
SA Contact Number 9000000003
Level of Petrol 0
06-04-2026 11383 SAMPLE TECHNICIAN  
06-12-2025 8600 SAMPLE TECHNICIAN  
Job Card Number PBRJC10000202600001
"""
    import json
    r = extract(SAMPLE)
    print(json.dumps(r, indent=2))
