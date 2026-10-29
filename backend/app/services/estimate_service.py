"""The ONE estimate engine. Matches extracted job-card parts against the Parts
Time master (``PartsMaster``) and computes the estimated service minutes.

    estimated_minutes = Σ( qty × matched PartsMaster.estimated_time )

PartsMaster.estimated_time is kept live (= unit_value × value_minutes) by the Parts
Time page's unit-conversion. Customer Voice is NEVER added here — the estimate comes
only from matched master data (no hardcoded service minutes, no guessing).

Match priority: exact part_number/product_code → exact normalized part_name →
job_code + normalized part_name → fuzzy name ≥ 0.90 (LOW_CONFIDENCE) → UNMATCHED.
"""
import difflib
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.part import PartsMaster

_FUZZY_MIN = 0.90


def _norm_num(s) -> str:
    return re.sub(r"\s+", "", (str(s) if s is not None else "").upper())


def _norm_name(s) -> str:
    return re.sub(r"[^A-Z0-9 ]", "", re.sub(r"\s+", " ", (str(s) if s is not None else "").upper())).strip()


def estimate_from_parts(db: Session, parts: list[dict]) -> dict:
    """parts = [{s_no, job_code, part_name, part_number, qty, unit_value}, …].
    Returns the structured Parts-Time analysis (see calculation_notes for caveats)."""
    masters = db.scalars(select(PartsMaster)).all()
    by_num: dict[str, PartsMaster] = {}
    by_name: dict[str, PartsMaster] = {}
    name_index = []
    for m in masters:
        for key in (m.part_number, m.product_code):
            nk = _norm_num(key)
            if nk:
                by_num.setdefault(nk, m)
        nn = _norm_name(m.part_name)
        if nn:
            by_name.setdefault(nn, m)
            name_index.append((nn, m))

    matched, low_conf, missing = [], [], []
    total = 0.0

    for p in (parts or []):
        try:
            qty = int(p.get("qty") or 1) or 1
        except Exception:
            qty = 1
        pn = _norm_num(p.get("part_number"))
        nm = _norm_name(p.get("part_name"))
        jc = _norm_num(p.get("job_code"))

        m = None
        method = None
        conf = 1.0
        if pn and pn in by_num:                       # 1 exact part number / product code
            m, method = by_num[pn], "PART_NUMBER"
        elif nm and nm in by_name:                    # 2 exact normalized name
            m, method = by_name[nm], "PART_NAME"
        elif nm:                                      # 3 job_code + name, else 4 fuzzy ≥ 0.90
            best, score = None, 0.0
            for cand_name, cand in name_index:
                r = difflib.SequenceMatcher(None, nm, cand_name).ratio()
                if r > score:
                    best, score, = cand, r
                    best_name = cand_name
            if best is not None and score >= _FUZZY_MIN:
                # exact job-code corroboration promotes a near-exact name to MATCHED
                if jc and _norm_num(best.product_code) == jc and score >= 0.97:
                    m, method, conf = best, "JOBCODE_NAME", round(score, 2)
                else:
                    m, method, conf = best, "FUZZY", round(score, 2)

        row = {
            "s_no": p.get("s_no"), "job_code": p.get("job_code"),
            "part_name": p.get("part_name"), "part_number": p.get("part_number"),
            "qty": qty,
        }
        if m is not None:
            minutes = int(round((m.estimated_time or 0) * qty))
            is_low = method == "FUZZY"
            row.update({
                "match": "LOW_CONFIDENCE_MATCH" if is_low else "MATCHED",
                "matched_part_name": m.part_name, "matched_part_number": m.part_number,
                "minutes_per_unit": round(m.estimated_time or 0, 1),
                "total_minutes": minutes, "match_method": method, "match_confidence": conf,
            })
            total += minutes
            (low_conf if is_low else matched).append(row)
        else:
            row.update({
                "match": "UNMATCHED", "matched_part_name": None,
                "minutes_per_unit": 0, "total_minutes": 0,
                "warning": "Not available in Parts Time master",
            })
            missing.append(row)

    extracted = len(parts or [])
    if extracted == 0:
        status = "extraction_failed"
    elif (len(matched) + len(low_conf)) == 0:
        status = "no_match"
    elif missing:
        status = "partial"
    else:
        status = "complete"

    notes = []
    if missing:
        notes.append(f"{len(missing)} part(s) not in the Parts Time master — excluded from the estimate.")
    if low_conf:
        notes.append(f"{len(low_conf)} part(s) matched by name similarity (≥0.90) — please verify.")
    notes.append("Estimate = Σ(qty × matched Parts Time minutes). Customer Voice is not counted.")

    return {
        "estimated_minutes": int(round(total)),
        "estimate_status": status,
        "extracted_count": extracted,
        "matched_count": len(matched),
        "low_confidence_count": len(low_conf),
        "missing_count": len(missing),
        "matched_parts": matched,
        "low_confidence_parts": low_conf,
        "missing_parts": missing,
        "calculation_notes": notes,
    }
