"""Geo helpers for Bike Test Drive Tracking (Phase 1) — pure Python, no PostGIS.

The backend is the source of truth for every final metric. These helpers operate on
plain point dicts ({"lat","lon","ts","speed_kmh"}) so they stay trivially testable.

    distance  : Σ haversine(consecutive valid points)
    speed     : device speed stored; computed_speed = dist / Δt
    stop      : COMPUTED (displacement) speed < 2 km/h AND within 30 m for ≥ 60 s
                (never one zero point; the noisy device speedometer is NOT used here)
    stop/move : stop_duration = Σ detected stop events; moving = total − stop_duration
                — derived from the same events so the two can never contradict.

Constants are the single source for thresholds (validation + stop detection).
"""
import math
from datetime import datetime

# ── tunables (single source) ───────────────────────────────────────
STOP_SPEED_THRESHOLD_KMH = 2.0
STOP_RADIUS_METERS = 30.0
MIN_STOP_SECONDS = 60
LOW_ACCURACY_THRESHOLD_METERS = 50.0
MAX_PLAUSIBLE_SPEED_KMH = 140.0

_EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two lat/lng points, in kilometres."""
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(dlon / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(a)))


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    return haversine_km(lat1, lon1, lat2, lon2) * 1000.0


def validate_range_time(lat, lon, ts) -> str | None:
    """Structural validity (range + timestamp). Returns an error string, or None."""
    if lat is None or lon is None:
        return "missing_coordinates"
    try:
        lat = float(lat); lon = float(lon)
    except (TypeError, ValueError):
        return "non_numeric_coordinates"
    if not (-90.0 <= lat <= 90.0):
        return "latitude_out_of_range"
    if not (-180.0 <= lon <= 180.0):
        return "longitude_out_of_range"
    if ts is None:
        return "missing_timestamp"
    return None


def _secs(a: datetime, b: datetime) -> float:
    return (b - a).total_seconds()


def segment_speed_kmh(lat1, lon1, t1: datetime, lat2, lon2, t2: datetime) -> float | None:
    """Backend-computed speed across a segment (km/h). None if Δt ≤ 0."""
    dt = _secs(t1, t2)
    if dt <= 0:
        return None
    km = haversine_km(lat1, lon1, lat2, lon2)
    return (km / dt) * 3600.0


def detect_stops(points: list[dict]) -> list[dict]:
    """A stop = a run of consecutive points staying within STOP_RADIUS_METERS of the
    cluster anchor with effective speed < STOP_SPEED_THRESHOLD_KMH, lasting
    ≥ MIN_STOP_SECONDS. ``points`` must be valid + time-sorted with keys lat/lon/ts
    and optional ``speed`` (effective km/h). Returns stop-event dicts."""
    stops: list[dict] = []
    i, n = 0, len(points)
    while i < n:
        p = points[i]
        if (p.get("speed") or 0.0) >= STOP_SPEED_THRESHOLD_KMH:
            i += 1
            continue
        # grow a cluster while points stay slow AND inside the radius of the anchor
        anchor = p
        j = i
        while j + 1 < n:
            q = points[j + 1]
            if (q.get("speed") or 0.0) >= STOP_SPEED_THRESHOLD_KMH:
                break
            if haversine_m(anchor["lat"], anchor["lon"], q["lat"], q["lon"]) > STOP_RADIUS_METERS:
                break
            j += 1
        dur = _secs(points[i]["ts"], points[j]["ts"])
        if dur >= MIN_STOP_SECONDS:
            cluster = points[i:j + 1]
            lat = sum(c["lat"] for c in cluster) / len(cluster)
            lon = sum(c["lon"] for c in cluster) / len(cluster)
            stops.append({
                "start_time": points[i]["ts"], "end_time": points[j]["ts"],
                "duration_seconds": int(round(dur)), "latitude": lat, "longitude": lon,
                "point_count": len(cluster), "radius_meters": STOP_RADIUS_METERS,
            })
            i = j + 1
        else:
            i += 1
    return stops


def summarize(points: list[dict]) -> dict:
    """Recompute the authoritative metrics from VALID, time-sorted points.

    ``points``: dicts with lat/lon/ts (datetime) and optional device ``speed_kmh``.
    Returns metrics + per-point ``computed_speed`` (aligned to ``points``) + stops.
    """
    pts = sorted(points, key=lambda p: p["ts"])
    n = len(pts)
    if n == 0:
        return {"total_distance_km": 0.0, "total_duration_seconds": 0,
                "moving_duration_seconds": 0, "stop_duration_seconds": 0,
                "average_speed_kmh": 0.0, "max_speed_kmh": 0.0, "stop_count": 0,
                "point_count": 0, "computed_speeds": [], "stops": [], "effective": []}

    total_km = 0.0
    computed = [None] * n          # computed (displacement) speed arriving AT each point
    for k in range(1, n):
        a, b = pts[k - 1], pts[k]
        km = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"])
        total_km += km
        dt = _secs(a["ts"], b["ts"])
        computed[k] = (km / dt) * 3600.0 if dt > 0 else 0.0

    total_secs = _secs(pts[0]["ts"], pts[-1]["ts"])

    # ── stops + stop/moving time, CONSISTENT BY CONSTRUCTION ──────────────
    # Stop detection runs on the COMPUTED DISPLACEMENT speed (radius-contained slow
    # runs), never the noisy device speedometer — GPS Doppler can read >2 km/h while
    # the bike isn't actually moving, which previously hid real stops. stop_duration
    # and moving are then DERIVED from the detected events, so the two can never
    # contradict (stop_count > 0  ⟺  stop_duration > 0; every ≥60 s same-place run
    # becomes exactly one stop event).
    stop_pts = [{"lat": pts[k]["lat"], "lon": pts[k]["lon"], "ts": pts[k]["ts"],
                 "speed": (computed[k] or 0.0)} for k in range(n)]
    stops = detect_stops(stop_pts)
    stop_secs = float(sum(st["duration_seconds"] for st in stops))
    moving_secs = max(0.0, total_secs - stop_secs)

    # max speed across valid points (device or computed), ignore implausible
    speeds = []
    for k in range(n):
        for v in (pts[k].get("speed_kmh"), computed[k]):
            if v is not None and v <= MAX_PLAUSIBLE_SPEED_KMH:
                speeds.append(v)
    max_speed = max(speeds) if speeds else 0.0

    moving_hours = moving_secs / 3600.0
    avg_speed = (total_km / moving_hours) if moving_hours > 0 else 0.0

    return {
        "total_distance_km": round(total_km, 3),
        "total_duration_seconds": int(round(total_secs)),
        "moving_duration_seconds": int(round(moving_secs)),
        "stop_duration_seconds": int(round(stop_secs)),
        "average_speed_kmh": round(avg_speed, 2),
        "max_speed_kmh": round(max_speed, 2),
        "stop_count": len(stops),
        "point_count": n,
        "computed_speeds": computed,     # aligned to sorted ``pts``
        "sorted_points": pts,
        "stops": stops,
    }
