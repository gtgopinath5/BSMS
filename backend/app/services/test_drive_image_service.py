"""Bike Test Drive Tracking — Phase 4: server-side route REPORT IMAGE.

Renders a premium dark-navigation-style PNG for a COMPLETED test drive:
  dark navy map  ·  glowing cyan travelled route  ·  white direction arrow
  ·  green start / black end / red stop markers  ·  summary metrics panel.

Stack (locked): Pillow + OpenStreetMap tiles (cached on disk). No Google Maps,
no headless browser, no numpy. OSM tiles are LIGHT, so we dark-style them with a
pure-PIL luminance->navy colorize (roads, being the brightest pixels, lift to a
muted blue-gray; land falls to navy). If tiles are unavailable the route still
renders accurately over a dark schematic fallback.

Backend stays the source of truth: every metric in the panel comes straight from
the Phase-1-computed columns; we only DRAW them. Only VALID GPS points are drawn.
This module is additive — it touches no lifecycle / closed code.
"""
from __future__ import annotations

import logging
import math
import os
import time
from pathlib import Path

from fastapi import HTTPException, status as http
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageOps, ImageEnhance
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models.test_drive import (
    TestDriveSession, TestDrivePoint, TestDriveStopEvent, TestDriveStatus,
)

log = logging.getLogger("baywatch.test_drive_image")

# ── storage (mirrors recording_service.MEDIA_ROOT) ─────────────────
MEDIA_ROOT = Path(os.environ.get("BW_MEDIA_ROOT") or (Path(__file__).resolve().parents[2] / "media"))
REPORT_DIR = MEDIA_ROOT / "test_drive_reports"
TILE_CACHE = MEDIA_ROOT / "map_tiles"

# ── canvas ─────────────────────────────────────────────────────────
W, H = 1080, 1440
PAD = 40
PANEL_RESERVE = 510          # bottom band kept clear of the route for the panel
TILE = 256
SS = 2                       # route layer supersample for anti-aliasing
TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
TILE_UA = "BaywatchTestDriveReport/1.0 (self-hosted bike-service OS; admin route report)"

# ── palette (from the approved spec) ───────────────────────────────
NAVY1 = (29, 48, 74)        # #1D304A  base land
NAVY2 = (36, 57, 85)        # #243955
DEEP = (11, 14, 40)         # #0B0E28  deep shadow / water
ROAD_LIGHT = (126, 151, 196)  # roads lift to this (muted blue-gray)
ROAD_MINOR = (42, 71, 92)   # #2A475C  (schematic minor roads)
ROUTE_CORE = (47, 239, 255)  # #2FEFFF
ROUTE_HL = (208, 250, 255)  # near-white centre highlight
ROUTE_GLOW = (0, 183, 232)  # #00B7E8
STOP = (255, 59, 48)        # #FF3B30
STOP_OUTLINE = (37, 10, 10)  # #250A0A
START = (46, 204, 113)      # #2ECC71
END = (17, 19, 24)          # #111318
ARROW_FILL = (255, 255, 255)
ARROW_SHADOW = (150, 165, 185)
ARROW_CIRCLE = (0, 92, 255)  # #005CFF
PANEL_BG = (10, 18, 30, 214)
PANEL_BORDER = ROUTE_CORE
TEXT = (236, 244, 252)
TEXT_DIM = (150, 170, 196)


# ════════════════════════════════════════════════════════════════
#  fonts
# ════════════════════════════════════════════════════════════════
_FONT_BOLD = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "Arial Bold.ttf",
]
_FONT_REG = [
    "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "Arial.ttf",
]
_font_cache: dict = {}


def _font(size: int, bold: bool = False):
    key = (size, bold)
    if key in _font_cache:
        return _font_cache[key]
    for p in (_FONT_BOLD if bold else _FONT_REG):
        try:
            f = ImageFont.truetype(p, size)
            _font_cache[key] = f
            return f
        except Exception:
            continue
    f = ImageFont.load_default()
    _font_cache[key] = f
    return f


# ════════════════════════════════════════════════════════════════
#  Web-Mercator projection (slippy-tile pixel space)
# ════════════════════════════════════════════════════════════════
def _global_px(lat: float, lon: float, z: int):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n * TILE
    lat_r = math.radians(max(-85.05, min(85.05, lat)))
    y = (1.0 - math.asinh(math.tan(lat_r)) / math.pi) / 2.0 * n * TILE
    return x, y


def _choose_zoom(bounds, fit_w, fit_h, max_z=18, min_z=2):
    min_lat, min_lon, max_lat, max_lon = bounds
    for z in range(max_z, min_z - 1, -1):
        x1, y1 = _global_px(max_lat, min_lon, z)
        x2, y2 = _global_px(min_lat, max_lon, z)
        if abs(x2 - x1) <= fit_w and abs(y2 - y1) <= fit_h:
            return z
    return min_z


# ════════════════════════════════════════════════════════════════
#  OSM tiles — cached download (gentle, offline-safe)
# ════════════════════════════════════════════════════════════════
def _tile_path(z, x, y) -> Path:
    return TILE_CACHE / str(z) / str(x) / f"{y}.png"


def _download_tile_cached(z, x, y, stats) -> Image.Image | None:
    """Return a 256² RGB tile. Cache-first; download once with a proper UA. After
    a couple of network failures we flip ``offline`` so the rest of the tiles fall
    back to navy instantly instead of waiting on dozens of timeouts."""
    n = 2 ** z
    if x < 0 or y < 0 or x >= n or y >= n:
        return None
    cp = _tile_path(z, x, y)
    if cp.exists():
        try:
            stats["cached"] += 1
            return Image.open(cp).convert("RGB")
        except Exception:
            try:
                cp.unlink()
            except Exception:
                pass
    if stats.get("offline"):
        return None
    try:
        import requests
        r = requests.get(TILE_URL.format(z=z, x=x, y=y), headers={"User-Agent": TILE_UA}, timeout=(3, 4))
        if r.status_code == 200 and r.content:
            cp.parent.mkdir(parents=True, exist_ok=True)
            cp.write_bytes(r.content)
            stats["downloaded"] += 1
            time.sleep(0.04)   # be gentle on the OSM tile server
            return Image.open(cp).convert("RGB")
        stats["fail"] += 1
    except Exception as e:
        stats["fail"] += 1
        if stats["fail"] >= 2:
            stats["offline"] = True
            log.warning("test-drive image: OSM tiles unreachable (%s) — using schematic fallback", type(e).__name__)
    return None


# ════════════════════════════════════════════════════════════════
#  dark navigation map style (pure PIL — no numpy)
# ════════════════════════════════════════════════════════════════
def apply_dark_map_style(img: Image.Image) -> Image.Image:
    """Light OSM tile -> dark-navy nav style. Luminance colorize: the brightest
    pixels (roads/labels, ~255) lift to a muted blue-gray; mid land (~238) sits at
    navy; water/parks (lower) sink to deep navy. Roads end up clearly lighter than
    land, which is what reads as a navigation map."""
    g = ImageOps.grayscale(img)
    g = ImageEnhance.Contrast(g).enhance(1.18)
    dark = ImageOps.colorize(
        g, black=DEEP, mid=NAVY1, white=ROAD_LIGHT,
        blackpoint=110, midpoint=232, whitepoint=255,
    ).convert("RGB")
    # gentle unify toward navy so disparate tiles read as one surface
    dark = Image.blend(dark, Image.new("RGB", img.size, NAVY2), 0.12)
    return dark


def _schematic_background() -> Image.Image:
    """Offline fallback: a dark-navy canvas with a faint street-like grid so the
    route still has spatial context. The route is still drawn from real GPS."""
    img = Image.new("RGB", (W, H), NAVY1)
    # subtle vertical vignette toward deep navy
    grad = Image.new("L", (1, H))
    for yy in range(H):
        grad.putpixel((0, yy), int(40 + 30 * (yy / H)))
    grad = grad.resize((W, H))
    img = Image.composite(Image.new("RGB", (W, H), DEEP), img, grad)
    d = ImageDraw.Draw(img)
    step = 96
    for gx in range(-40, W + step, step):
        d.line([(gx, 0), (gx + 60, H)], fill=ROAD_MINOR, width=2)
    for gy in range(0, H + step, step):
        d.line([(0, gy), (W, gy - 40)], fill=ROAD_MINOR, width=2)
    return img


def _build_base_map(pts, bounds, stats):
    """Composite OSM tiles into the 1080x1440 canvas, dark-styled, with the route's
    centre placed in the upper region (panel sits below). Returns (img, to_canvas)."""
    fit_w, fit_h = W - 2 * PAD, H - 2 * PAD - PANEL_RESERVE
    z = _choose_zoom(bounds, fit_w, fit_h)
    # route centre in global px
    xs = [_global_px(la, lo, z) for la, lo in pts]
    gx_min = min(p[0] for p in xs); gx_max = max(p[0] for p in xs)
    gy_min = min(p[1] for p in xs); gy_max = max(p[1] for p in xs)
    cx = (gx_min + gx_max) / 2.0
    cy = (gy_min + gy_max) / 2.0
    target_cy = PAD + fit_h / 2.0                      # keep route above the panel
    tl_x = cx - W / 2.0
    tl_y = cy - target_cy

    def to_canvas(lat, lon):
        gx, gy = _global_px(lat, lon, z)
        return (gx - tl_x, gy - tl_y)

    canvas = Image.new("RGB", (W, H), NAVY1)
    tx0 = int(math.floor(tl_x / TILE)); tx1 = int(math.floor((tl_x + W) / TILE))
    ty0 = int(math.floor(tl_y / TILE)); ty1 = int(math.floor((tl_y + H) / TILE))
    any_tile = False
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            tile = _download_tile_cached(z, tx, ty, stats)
            if tile is None:
                continue
            any_tile = True
            canvas.paste(tile, (int(tx * TILE - tl_x), int(ty * TILE - tl_y)))

    if any_tile:
        base = apply_dark_map_style(canvas)
        stats["fallback"] = False
    else:
        base = _schematic_background()
        stats["fallback"] = True
    return base, to_canvas


# ════════════════════════════════════════════════════════════════
#  route + markers + arrow + panel
# ════════════════════════════════════════════════════════════════
def _poly(draw, pts, width, fill):
    if len(pts) >= 2:
        draw.line(pts, fill=fill, width=int(width), joint="curve")
    r = width / 2.0
    for p in (pts[0], pts[-1]):
        draw.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=fill)


def _draw_route(base: Image.Image, canvas_pts):
    """Glow + core + highlight, rendered on a 2x layer for clean anti-aliasing."""
    layer = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    sp = [(x * SS, y * SS) for x, y in canvas_pts]
    # outer glow
    glow = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    _poly(gd, sp, 22 * SS, (*ROUTE_GLOW, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(11 * SS))
    layer = Image.alpha_composite(layer, glow)
    d = ImageDraw.Draw(layer)
    _poly(d, sp, 13 * SS, (*ROUTE_CORE, 255))     # main route
    _poly(d, sp, 5 * SS, (*ROUTE_HL, 235))        # centre highlight
    layer = layer.resize((W, H), Image.LANCZOS)
    base.paste(Image.alpha_composite(base.convert("RGBA"), layer).convert("RGB"), (0, 0))


def _disc(draw, c, r, fill, outline=None, ow=0):
    draw.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=fill,
                 outline=outline, width=ow)


def _fmt_dur(sec):
    """Compact stop duration for map labels: '45s', '1m 10s', '7m 05s'."""
    s = int(sec or 0)
    m, ss = s // 60, s % 60
    return f"{m}m {ss:02d}s" if m else f"{ss}s"


def _stop_label(draw, c, r, text, long):
    """Red rounded label near a stop marker, clamped inside the canvas."""
    lf = _font(20, bold=True)
    tb = draw.textbbox((0, 0), text, font=lf)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    padx, pady = 11, 7
    bw, bh = tw + 2 * padx, th + 2 * pady
    bx = min(W - bw - 8, max(8, c[0] - bw / 2))
    by = max(8, c[1] - r - 12 - bh)
    draw.rounded_rectangle([bx, by, bx + bw, by + bh], radius=9,
                           fill=((92, 14, 14) if long else (58, 12, 12)), outline=STOP, width=2)
    draw.text((bx + padx, by + pady - tb[1]), text, font=lf, fill=(255, 236, 236))


def _draw_markers(img, draw, canvas_pts, stop_pts):
    # stops (red) — drawn under start/end, each with a red DURATION label
    MAX_LABELS = 5
    for i, (c, dur) in enumerate(stop_pts, start=1):
        long = dur is not None and dur >= 300
        r = 20 if long else 15
        if long:   # warning ring for long stops
            _disc(draw, c, r + 8, None, outline=(*STOP, 180), ow=4)
        _disc(draw, c, r, STOP, outline=STOP_OUTLINE, ow=4)
        _disc(draw, c, max(3, r // 4), (255, 255, 255), None)
        if i <= MAX_LABELS:
            label = (f"LONG STOP · {_fmt_dur(dur)}" if long else f"STOP {i} · {_fmt_dur(dur)}")
            _stop_label(draw, c, r, label, long)
    extra = len(stop_pts) - MAX_LABELS
    if extra > 0:
        draw.text((PAD + 6, PAD + 6), f"+{extra} more stops", font=_font(22, bold=True), fill=(255, 200, 200))
    # start (green) + end (black)
    s, e = canvas_pts[0], canvas_pts[-1]
    _disc(draw, s, 17, START, outline=(255, 255, 255), ow=5)
    _disc(draw, e, 17, END, outline=(255, 255, 255), ow=5)
    lf = _font(20, bold=True)
    draw.text((s[0] - 22, s[1] - 44), "START", font=lf, fill=START)
    draw.text((e[0] - 16, e[1] - 44), "END", font=lf, fill=(225, 232, 240))


def _draw_arrow(img, canvas_pts):
    """White direction arrow (vehicle indicator) with a translucent blue halo,
    placed a little before the end and rotated to the final bearing."""
    if len(canvas_pts) < 2:
        return
    ex, ey = canvas_pts[-1]
    px, py = canvas_pts[-2]
    for i in range(len(canvas_pts) - 2, -1, -1):   # find a segment with length
        px, py = canvas_pts[i]
        if (ex - px) ** 2 + (ey - py) ** 2 > 4:
            break
    ang = math.atan2(ey - py, ex - px)
    back = 64
    ax, ay = ex - math.cos(ang) * back, ey - math.sin(ang) * back
    # blue halo
    halo = Image.new("RGBA", img.size, (0, 0, 0, 0))
    hd = ImageDraw.Draw(halo)
    hd.ellipse([ax - 52, ay - 52, ax + 52, ay + 52], fill=(*ARROW_CIRCLE, 150))
    img.paste(Image.alpha_composite(img.convert("RGBA"), halo).convert("RGB"), (0, 0))
    # arrow polygon (pointing +x) then rotate
    tip, half, tail = 30, 22, 16
    poly = [(tip, 0), (-tail, -half), (-tail + 12, 0), (-tail, half)]
    ca, sa = math.cos(ang), math.sin(ang)
    pts = [(ax + p[0] * ca - p[1] * sa, ay + p[0] * sa + p[1] * ca) for p in poly]
    d = ImageDraw.Draw(img)
    d.polygon([(x + 2, y + 2) for x, y in pts], fill=ARROW_SHADOW)
    d.polygon(pts, fill=ARROW_FILL, outline=(210, 222, 236))


def _fit(s, n):
    s = "" if s is None else str(s)
    return s if len(s) <= n else s[: n - 1] + "…"


def _hms(sec):
    s = int(sec or 0)
    h, m, ss = s // 3600, (s % 3600) // 60, s % 60
    return (f"{h}:" if h else "") + f"{m:02d}:{ss:02d}"


def _draw_panel(img, s: TestDriveSession, quality: dict | None = None):
    def tt(dt):
        return dt.strftime("%d %b %H:%M") if dt else "—"
    ph = 470
    px0, py0 = PAD, H - PAD - ph
    panel = Image.new("RGBA", (W - 2 * PAD, ph), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle([0, 0, W - 2 * PAD - 1, ph - 1], radius=26, fill=PANEL_BG,
                         outline=(*PANEL_BORDER, 235), width=3)
    pd.rounded_rectangle([18, 18, 78, 24], radius=3, fill=(*PANEL_BORDER, 255))   # cyan accent
    img.paste(Image.alpha_composite(img.crop((px0, py0, px0 + W - 2 * PAD, py0 + ph)).convert("RGBA"), panel).convert("RGB"), (px0, py0))

    d = ImageDraw.Draw(img)
    x = px0 + 30
    y = py0 + 34
    d.text((x, y), "BIKE TEST DRIVE REPORT", font=_font(36, bold=True), fill=TEXT)
    y += 48
    bike = f"{_fit(s.bike_registration, 16)} · {_fit(s.bike_model, 22)}"
    d.text((x, y), bike, font=_font(26, bold=True), fill=ROUTE_CORE)
    y += 38
    d.text((x, y), f"Job Card: {_fit(s.job_card_number, 22)}    Customer: {_fit(s.customer_name, 22)}", font=_font(22), fill=TEXT_DIM)
    y += 32
    # service worker vs test-drive worker — ALWAYS separate
    sw = _fit(getattr(s, "service_worker_name", None) or "—", 18)
    tw = _fit(s.worker_name or "—", 18)
    d.text((x, y), f"Service Worker: {sw}", font=_font(22), fill=TEXT_DIM)
    d.text((x + 470, y), f"Test Drive Worker: {tw}", font=_font(22), fill=TEXT_DIM)
    y += 36

    # two-column metric grid
    rows = [
        ("Distance", f"{(s.total_distance_km or 0):.2f} km", "Total Time", _hms(s.total_duration_seconds)),
        ("Moving", _hms(s.moving_duration_seconds), "Stopped", _hms(s.stop_duration_seconds)),
        ("Avg Speed", f"{(s.average_speed_kmh or 0):.1f} km/h", "Max Speed", f"{(s.max_speed_kmh or 0):.1f} km/h"),
        ("Stops", str(s.stop_count if s.stop_count is not None else 0), "GPS Points", str(s.point_count if s.point_count is not None else 0)),
    ]
    colx = [x, x + 250, x + 500, x + 760]
    lf, vf = _font(22), _font(26, bold=True)
    for la, lv, ra, rv in rows:
        d.text((colx[0], y + 4), la.upper(), font=lf, fill=TEXT_DIM)
        d.text((colx[1], y), lv, font=vf, fill=TEXT)
        d.text((colx[2], y + 4), ra.upper(), font=lf, fill=TEXT_DIM)
        d.text((colx[3], y), rv, font=vf, fill=TEXT)
        y += 40
    # GPS quality (only when there is anything noteworthy)
    if quality and (quality.get("invalid") or quality.get("low")):
        d.text((x, y + 2), f"Valid {quality.get('valid', 0)}  ·  Invalid {quality.get('invalid', 0)}  ·  Low-Acc {quality.get('low', 0)}",
               font=_font(21), fill=(255, 196, 120))
        y += 32
    y += 4
    d.text((x, y), f"{tt(s.started_at)}  →  {tt(s.ended_at)}", font=_font(20), fill=TEXT_DIM)


# ════════════════════════════════════════════════════════════════
#  orchestration
# ════════════════════════════════════════════════════════════════
def _valid_points(db: Session, session_id: str):
    rows = db.scalars(select(TestDrivePoint).where(
        TestDrivePoint.session_id == session_id).order_by(TestDrivePoint.sequence_no)).all()
    return [(r.latitude, r.longitude) for r in rows
            if r.is_valid and r.latitude is not None and r.longitude is not None
            and -90 <= r.latitude <= 90 and -180 <= r.longitude <= 180]


def _stops(db: Session, session_id: str):
    return db.scalars(select(TestDriveStopEvent).where(
        TestDriveStopEvent.session_id == session_id).order_by(TestDriveStopEvent.start_time)).all()


def _point_quality(db: Session, session_id: str) -> dict:
    rows = db.scalars(select(TestDrivePoint).where(TestDrivePoint.session_id == session_id)).all()
    return {
        "valid": sum(1 for r in rows if r.is_valid),
        "invalid": sum(1 for r in rows if not r.is_valid),
        "low": sum(1 for r in rows if (r.accuracy_meters or 0) > LOW_ACCURACY_THRESHOLD_METERS),
    }


LOW_ACCURACY_THRESHOLD_METERS = 50.0


def _pad_bounds(bounds, min_span_m: float = 300.0):
    """Expand a tiny route's bounds to a minimum ~300 m window so a 0.05–0.5 km drive
    isn't zoomed to an unreadable point. Centre is preserved; only the span grows."""
    min_lat, min_lon, max_lat, max_lon = bounds
    clat, clon = (min_lat + max_lat) / 2.0, (min_lon + max_lon) / 2.0
    mlon = 111320.0 * max(0.2, math.cos(math.radians(clat)))
    half_lat = max(min_span_m, (max_lat - min_lat) * 111320.0) / 2.0 / 111320.0
    half_lon = max(min_span_m, (max_lon - min_lon) * mlon) / 2.0 / mlon
    return (clat - half_lat, clon - half_lon, clat + half_lat, clon + half_lon)


def generate_test_drive_route_image(db: Session, session_id: str, force: bool = False) -> dict:
    """Render (or reuse) the route report PNG. Returns stats incl. the file path.
    Raises HTTPException with a clean message on any blocking condition."""
    s = db.get(TestDriveSession, session_id)
    if not s:
        raise HTTPException(http.HTTP_404_NOT_FOUND, "Test drive session not found")
    if s.status != TestDriveStatus.completed:
        raise HTTPException(http.HTTP_409_CONFLICT,
                            f"Route image is available only after the test drive is completed (current: {s.status.value})")

    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    out = REPORT_DIR / f"{session_id}.png"
    if out.exists() and not force:
        if not s.route_image_path:
            s.route_image_path = str(out)
            s.route_image_url = f"/api/v1/test-drives/{session_id}/route-image"
            db.commit()
        return {"path": str(out), "regenerated": False, "cached": 0, "downloaded": 0, "fallback": None}

    pts = _valid_points(db, session_id)
    if len(pts) < 2:
        raise HTTPException(http.HTTP_400_BAD_REQUEST,
                            "Not enough valid GPS points to render a route (need at least 2)")

    bounds = _pad_bounds((min(p[0] for p in pts), min(p[1] for p in pts),
                          max(p[0] for p in pts), max(p[1] for p in pts)))
    stats = {"downloaded": 0, "cached": 0, "fail": 0, "offline": False, "fallback": None}
    try:
        base, to_canvas = _build_base_map(pts, bounds, stats)
        canvas_pts = [to_canvas(la, lo) for la, lo in pts]
        _draw_route(base, canvas_pts)
        draw = ImageDraw.Draw(base)
        stop_pts = [(to_canvas(st.latitude, st.longitude), st.duration_seconds)
                    for st in _stops(db, session_id)
                    if st.latitude is not None and st.longitude is not None]
        _draw_markers(base, draw, canvas_pts, stop_pts)
        _draw_arrow(base, canvas_pts)
        _draw_panel(base, s, _point_quality(db, session_id))
        base.save(out, "PNG")
    except HTTPException:
        raise
    except Exception:
        log.exception("test-drive route image generation failed for %s", session_id)
        raise HTTPException(http.HTTP_500_INTERNAL_SERVER_ERROR, "Could not generate the route image")

    s.route_image_path = str(out)
    s.route_image_url = f"/api/v1/test-drives/{session_id}/route-image"
    db.commit()
    stats["path"] = str(out)
    stats["regenerated"] = True
    return stats


def get_or_generate_route_image(db: Session, session_id: str) -> str:
    """Path to the report PNG, generating it on first request. Used by the route."""
    info = generate_test_drive_route_image(db, session_id, force=False)
    return info["path"]
