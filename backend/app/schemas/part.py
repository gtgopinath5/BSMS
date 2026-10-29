from datetime import datetime
from pydantic import BaseModel, ConfigDict


class PartCreate(BaseModel):
    product_code: str | None = None
    part_number: str | None = None
    part_name: str
    model: str | None = None
    unit_value: float = 0
    unit_time: float = 0


class PartUpdate(BaseModel):
    product_code: str | None = None
    part_number: str | None = None
    part_name: str | None = None
    model: str | None = None
    unit_value: float | None = None
    unit_time: float | None = None


class PartOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    product_code: str | None = None
    part_number: str | None = None
    part_name: str
    model: str | None = None
    unit_value: float
    unit_time: float
    estimated_time: float
    source_file_id: str | None = None
    source_file_name: str | None = None
    imported_by: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class UnitConversionUpdate(BaseModel):
    value_minutes: float
    confirm: bool = False


# ── Client-side-extracted bulk import ──────────────────────────────
class ImportRow(BaseModel):
    pn: str | None = None            # part number  (maps Material)
    name: str = ""                   # part name    (Material description)
    code: str | None = None          # product code
    model: str | None = None         # vehicle / model grouping
    units: float = 1                 # unit value (labour units)


class ImportRowsBody(BaseModel):
    file_name: str
    file_type: str = "excel"         # excel | pdf
    size_bytes: int = 0
    rows: list[ImportRow] = []
