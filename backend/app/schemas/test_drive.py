"""Pydantic request schemas for Bike Test Drive Tracking (Phase 1)."""
from pydantic import BaseModel


class AssignTestDriveRequest(BaseModel):
    # one of these identifies the COMPLETED job to attach the drive to
    service_session_id: str | None = None
    job_card_id: str | None = None
    worker_id: str | None = None          # optional override; defaults to the session's worker
    notes: str | None = None


class GpsPointIn(BaseModel):
    latitude: float | None = None
    longitude: float | None = None
    timestamp: str | None = None          # ISO 8601 (device clock); parsed to naive UTC
    speed_kmh: float | None = None        # device-reported, optional
    accuracy_meters: float | None = None
    heading: float | None = None
    altitude: float | None = None
    source: str | None = None             # browser_gps | device_gps | manual_test


class StartTestDriveRequest(BaseModel):
    # start REQUIRES an initial location fix
    latitude: float
    longitude: float
    timestamp: str | None = None
    accuracy_meters: float | None = None
    speed_kmh: float | None = None
    source: str | None = None


class ApproveTestDriveRequest(BaseModel):
    # worker approval REQUIRES an initial location fix (no silent tracking) plus
    # device-continuity metadata used for the connection status display
    latitude: float
    longitude: float
    timestamp: str | None = None
    accuracy_meters: float | None = None
    speed_kmh: float | None = None
    heading: float | None = None
    altitude: float | None = None
    source: str | None = None
    device_id: str | None = None          # localStorage continuity id (not auth)
    user_agent: str | None = None


class PointsBatchIn(BaseModel):
    points: list[GpsPointIn] = []
