"""Application settings, read from environment / .env."""
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Deployment profile. "development" (default) is zero-config and never blocks
    # boot. Set APP_ENV=production to enable fail-fast validation of insecure
    # config at startup (see app/startup.py). Optional integrations stay optional.
    app_env: str = "development"

    # Database — SQLite by default for a zero-config local run.
    database_url: str = "sqlite:///./baywatch.db"

    # Redis / Celery (optional — timer falls back to memory if unreachable)
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"

    # JWT
    jwt_secret: str = "change-me-to-a-long-random-secret"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 720

    # Integration settings encryption — Fernet key for secrets stored in the
    # integration_settings table. Unset → a key is derived from jwt_secret so a
    # local run works zero-config (set a dedicated key in production).
    integration_secret_key: str = ""

    # MinIO / S3 (optional)
    minio_url: str = "http://localhost:9000"
    minio_access_key: str = "minioadmin"
    minio_secret_key: str = "minioadmin"
    minio_region: str = "us-east-1"

    # Recording retention
    recording_retention_days: int = 14

    # Customer approval (Phase 2): link TTL + date-wise temporary-history retention window.
    # An unsubmitted link expires after this many days; submitted approval records stay on the
    # active dashboard for this window, then are soft-expired/hidden.
    customer_approval_retention_days: int = 14

    # Vehicle Intake Evidence: bike photos + complaint voice notes are TEMPORARY evidence.
    # Media auto-expires this many days after submit (access stops + files purged); the intake
    # entry archives once all its media is gone. Core business records are never deleted.
    intake_media_retention_days: int = 14

    # ── AI Barricade Vehicle Detection (Phase B — simulation) ──────────
    # Detection frames are TEMPORARY evidence: auto-purged this many days after capture (event
    # metadata + decision audit are kept forever). The YOLO/OCR confidence floors below the
    # backed decision falls back to pending_admin (fail-safe). Simulation mode is the dev default
    # (no real relay hardware). Ingest is NEVER public: an internal token (if set) gates the
    # detection-service POST; otherwise admin/master auth is required.
    barricade_media_retention_days: int = 30
    barricade_default_detection_threshold: float = 0.45
    barricade_default_ocr_threshold: float = 0.60
    barricade_simulation_enabled: bool = True
    barricade_realtime_interval_seconds: int = 1
    barricade_ingest_token: str = ""          # shared secret for the detection service (blank → off)
    barricade_relay_timeout_seconds: int = 3  # http/mqtt relay actuation timeout (fail-safe on expiry)
    # Hardware pilot: when true, an open requires healthy live safety telemetry (controller online,
    # no fault, photo-beam clear). Default OFF so simulation/existing behaviour is unchanged; a
    # per-controller flag can also turn it on for a single real lane.
    barricade_require_safety_status_for_open: bool = False

    # Google Drive archival (Stage 3) — set both to enable real uploads.
    # Service-account JSON path + destination folder id. Unset → archival is
    # inactive and recordings stay on local SSD (never a placeholder upload).
    google_drive_credentials: str = ""
    google_drive_folder_id: str = ""

    # MQTT — ESP32 physical bay timers. Backend publishes timer state/events;
    # ESP32 subscribes and only displays. Unset broker → MQTT is dormant (the
    # backend timer remains the single source of truth either way).
    mqtt_broker_host: str = "localhost"
    mqtt_broker_port: int = 1883
    mqtt_username: str = ""
    mqtt_password: str = ""
    mqtt_enabled: bool = True          # set false to disable publishing entirely
    mqtt_topic_prefix: str = "bay"     # topics: {prefix}/{bay_number}/{event}

    # CORS
    cors_origins: str = "http://localhost:7890,http://localhost:3000"

    # Notifications — SMS via MSG91 (India), Email via SendGrid
    msg91_auth_key: str = ""
    msg91_sender_id: str = "BAYWTC"   # 6-char DLT-approved sender ID
    msg91_flow_id: str = ""           # DLT template / flow id (v5 API); blank → legacy route
    msg91_route: str = "4"            # legacy route: 4 = transactional
    sendgrid_api_key: str = ""
    from_email: str = "noreply@baywatch.app"

    # ── Customer Live Watch ────────────────────────────────────────────
    # Public origin used to build the temporary watch link handed to customers.
    # Same-origin as the API (the backend serves /customer-watch/{token}).
    customer_watch_base_url: str = "http://localhost:8000"
    customer_watch_ttl_hours: int = 12          # link auto-expires this long after issue

    # WhatsApp Business — Meta Cloud API (Graph). All unset → WhatsApp send is a
    # graceful no-op (Copy-Link still works); the link is never blocked on it.
    whatsapp_phone_number_id: str = ""          # Meta phone_number_id
    whatsapp_access_token: str = ""             # permanent system-user token
    whatsapp_template_name: str = "service_live_link"
    whatsapp_template_lang: str = "en"
    whatsapp_api_version: str = "v21.0"
    whatsapp_default_country_code: str = "91"   # India — prefixed when a mobile is local

    # Seed demo data on first boot
    seed_on_startup: bool = True

    @property
    def cors_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
