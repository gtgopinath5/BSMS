from pydantic import BaseModel, ConfigDict
from ..models.job import Priority


class JobCardCreate(BaseModel):
    vehicle_number: str | None = None
    vehicle_model: str | None = None
    chassis_number: str | None = None
    engine_number: str | None = None
    km_reading: str | None = None
    customer_name: str | None = None
    customer_mobile: str | None = None
    customer_email: str | None = None
    customer_address: str | None = None
    customer_id: str | None = None       # link to an existing customer user (optional)
    service_type: str | None = None
    repair_type: str | None = None
    estimated_cost: float | None = None
    estimated_minutes: int = 45
    complaint: str | None = None         # Customer Voice
    notes: str | None = None
    services: list | None = None         # parsed service / parts-time analysis (voice context)
    parts: list | None = None            # extracted + matched Parts Detail rows (PDF)
    estimate_status: str | None = None   # complete | partial | no_match | extraction_failed
    extraction_confidence: float | None = None
    source_type: str | None = None       # manual | pdf
    # Bay-first: the admin picks a BAY; the worker is resolved from the bay's
    # current worker (primary, or active temporary replacement). worker_id is
    # never sent by the UI — it's optional only for legacy/internal callers.
    bay_id: str | None = None            # the chosen bay (drives everything)
    worker_id: str | None = None         # derived from the bay; legacy fallback
    priority: Priority = Priority.medium


class JobCardUpdate(BaseModel):
    vehicle_number: str | None = None
    vehicle_model: str | None = None
    chassis_number: str | None = None
    engine_number: str | None = None
    km_reading: str | None = None
    customer_name: str | None = None
    customer_mobile: str | None = None
    customer_email: str | None = None
    customer_address: str | None = None
    service_type: str | None = None
    repair_type: str | None = None
    estimated_cost: float | None = None
    estimated_minutes: int | None = None
    complaint: str | None = None
    notes: str | None = None


class ChangeBayRequest(BaseModel):
    bay_id: str | None = None


class QueueItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    job_card_id: str
    worker_id: str
    bay_id: str | None = None
    queue_position: int
    status: str
    priority: str


class AssignRequest(BaseModel):
    bay_id: str
    force: bool = False


class ReassignRequest(BaseModel):
    worker_id: str


class MoveRequest(BaseModel):
    direction: str   # "up" | "down"
