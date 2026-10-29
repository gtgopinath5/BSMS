"""MinIO / S3 object storage wrapper.

Raw bucket URLs are never exposed — callers always receive a *signed* URL.
If MinIO is not configured/reachable, the helpers degrade gracefully so the
API still boots (uploads become no-ops, signed URLs fall back to the
deterministic dev URL in `recordings.signed_url`).
"""
from functools import lru_cache

from ..config import settings

BUCKETS = ["job-cards", "profile-photos", "service-recordings", "completion-pdfs"]


@lru_cache
def _client():
    try:
        import boto3  # imported lazily
        from botocore.client import Config
        c = boto3.client(
            "s3",
            endpoint_url=settings.minio_url,
            aws_access_key_id=settings.minio_access_key,
            aws_secret_access_key=settings.minio_secret_key,
            region_name=settings.minio_region,
            config=Config(signature_version="s3v4"),
        )
        return c
    except Exception:
        return None


def ensure_buckets() -> None:
    c = _client()
    if not c:
        return
    try:
        existing = {b["Name"] for b in c.list_buckets().get("Buckets", [])}
        for b in BUCKETS:
            if b not in existing:
                c.create_bucket(Bucket=b)
    except Exception:
        pass  # storage optional in dev


def upload_file(bucket: str, key: str, data: bytes, content_type: str) -> str | None:
    c = _client()
    if not c:
        return None
    try:
        c.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
        return f"{bucket}/{key}"
    except Exception:
        return None


def generate_signed_url(bucket: str, key: str, expires_in: int = 3600) -> str | None:
    c = _client()
    if not c:
        return None
    try:
        return c.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_in
        )
    except Exception:
        return None


def delete_file(bucket: str, key: str) -> None:
    c = _client()
    if not c:
        return
    try:
        c.delete_object(Bucket=bucket, Key=key)
    except Exception:
        pass
