"""Import all models so SQLAlchemy's metadata is fully populated."""
from .branch import Branch
from .user import User, UserRole
from .bay import Bay, BayTempAssignment
from .camera_device import BayCamera
from .timer_device import TimerDevice
from .part import ImportedFile, PartsMaster, UnitConversionSetting
from .job import JobCard, JobQueue, QueueStatus, Priority
from .session import (
    ServiceSession, CameraSession, RecordingSession, Notification,
    SessionStatus, RecordingStatus,
)
from .audit import AuditLog
from .leave import LeaveRequest, LeaveStatus
from .customer_watch import CustomerWatchSession, WatchDecision, WatchStatus, WATCH_DEAD
from .customer_approval import (
    CustomerApprovalRequest, CustomerApprovalItem, CustomerApprovalEvent,
    CustomerApprovalVersion, CustomerApprovalLink,
    REQUEST_STATUSES, LOCKED_STATUSES, RESPONSE_STATUSES,
    VERSION_STATUSES, LINK_STATUSES, LINK_DEAD,
)
from .integration_settings import IntegrationSettings, PROVIDERS
from .test_drive import (
    TestDriveSession, TestDrivePoint, TestDriveStopEvent, TestDriveStatus, PointSource,
)
from .vehicle_intake import (
    VehicleIntakeEntry, VehicleIntakeMedia, VehicleIntakeEvent,
    ENTRY_STATUSES, MEDIA_TYPES, MEDIA_STATUSES, ACTOR_TYPES,
)
from .barricade import (
    BarricadeCameraConfig, BarricadeControllerConfig, BarricadeEvent, BarricadeMedia,
    BarricadeBillApproval, BarricadeTemporaryApproval, BarricadeDecisionLog,
    DIRECTIONS, CONTROLLER_TYPES, OBJECT_TYPES, EVENT_STATUSES,
)
from .worker_transition import (
    WorkerTransitionDelayReason, THRESHOLD_STATUSES, REASON_CATEGORIES, RESPONSIBLE_TYPES,
)

__all__ = [
    "Branch", "User", "UserRole", "Bay", "BayTempAssignment", "BayCamera", "TimerDevice",
    "ImportedFile", "PartsMaster", "UnitConversionSetting",
    "JobCard", "JobQueue", "QueueStatus", "Priority",
    "ServiceSession", "CameraSession", "RecordingSession", "Notification",
    "SessionStatus", "RecordingStatus", "AuditLog",
    "LeaveRequest", "LeaveStatus",
    "CustomerWatchSession", "WatchDecision", "WatchStatus", "WATCH_DEAD",
    "CustomerApprovalRequest", "CustomerApprovalItem", "CustomerApprovalEvent",
    "CustomerApprovalVersion", "CustomerApprovalLink",
    "REQUEST_STATUSES", "LOCKED_STATUSES", "RESPONSE_STATUSES",
    "VERSION_STATUSES", "LINK_STATUSES", "LINK_DEAD",
    "IntegrationSettings", "PROVIDERS",
    "TestDriveSession", "TestDrivePoint", "TestDriveStopEvent", "TestDriveStatus", "PointSource",
    "VehicleIntakeEntry", "VehicleIntakeMedia", "VehicleIntakeEvent",
    "ENTRY_STATUSES", "MEDIA_TYPES", "MEDIA_STATUSES", "ACTOR_TYPES",
    "BarricadeCameraConfig", "BarricadeControllerConfig", "BarricadeEvent", "BarricadeMedia",
    "BarricadeBillApproval", "BarricadeTemporaryApproval", "BarricadeDecisionLog",
    "DIRECTIONS", "CONTROLLER_TYPES", "OBJECT_TYPES", "EVENT_STATUSES",
    "WorkerTransitionDelayReason", "THRESHOLD_STATUSES", "REASON_CATEGORIES", "RESPONSIBLE_TYPES",
]
