# Bike Test Drive Tracking

Real-GPS road-test tracking for completed bike services. After a service job is
**completed**, an admin assigns a test drive; the worker captures real GPS from the
mobile portal; the backend stores every point and computes the **authoritative**
metrics (distance, durations, speeds, stops); the admin reviews the route on an
interactive map and can generate a premium dark-navigation **route report image**.

> **Source of truth = the backend.** No fake GPS, no fake route, no fake speed. The
> frontend never computes final metrics — it only displays what the backend stored.
> The whole module is **additive**: it does not touch the service lifecycle,
> workflow engine, Work Completion PDF, `derive_pause`, Customer Live Watch,
> Camera/Timer modules, MQTT, Drive, WhatsApp, Auth/RBAC, or the recording path.

---

## 1. Feature overview

| | |
|---|---|
| **Who assigns** | Branch admin, on a **completed** service job only |
| **Who drives** | The assigned worker, via the worker mobile portal |
| **What is captured** | Real browser GPS points (lat/lon/timestamp/speed/accuracy/heading/altitude) |
| **What the backend computes** | Distance (Haversine), total/moving/stop durations, avg/max speed, stop events |
| **What the admin sees** | Live/summary tables, a Leaflet+OSM route map, stop list, GPS-quality warnings, and a generated PNG route report |
| **Map stack** | OpenStreetMap + Leaflet (interactive) and Pillow+OSM (static image). **No Google Maps.** |

---

## 2. Full workflow

```
1. Service job reaches COMPLETED (existing lifecycle — untouched)
2. Admin → "Bike Test Drive Tracking" → Assign Test Drive  (picks a completed job)
        → backend creates a test_drive_sessions row (status = assigned)
3. Worker portal → "Test Drive" → sees the assigned drive
        → accepts the consent notice → taps START
        → browser asks for GPS permission → first fix is POSTed (status = running)
4. watchPosition streams points; the page batches them to the backend every ~7s
        → backend validates + stores every point (valid + invalid for audit)
5. Worker taps END
        → pending points flushed → POST /complete
        → backend recomputes ALL metrics + detects stop events (status = completed)
        → GPS tracking stops immediately
6. Admin opens the drive → metrics, Leaflet route, stops, quality warnings
7. Admin → "View Route Image" → backend generates a 1080x1440 dark-nav PNG
        (PIL + cached OSM tiles), served token-gated; "Regenerate" rebuilds it
```

---

## 3. Phase summary

| Phase | Scope | Key artifacts |
|---|---|---|
| **1** | Backend: tables, geo math, service, APIs | `models/test_drive.py`, `utils/geo.py`, `services/test_drive_service.py`, `routers/test_drives.py`, `schemas/test_drive.py` |
| **2** | Worker mobile GPS page | `LiveWorkerTestDrive` (live.jsx), `.td-*` CSS, api.js worker methods |
| **3** | Admin tracking page (Leaflet/OSM) | `LiveTestDriveTracking` + `TdtDetail` + `TdtMap` + `TdtAssignModal` (live.jsx), `.tdt-*` CSS |
| **4** | Server-side route report image | `services/test_drive_image_service.py`, route-image endpoints, `TdtRouteImage` |
| **5** | Polish, hardening, documentation | warning labels, this document, full regression |

---

## 4. Database tables (`backend/app/models/test_drive.py`)

All three are additive, created via `create_all` + idempotent `ensure_test_drive_schema()`
(registered in `main.py` lifespan). Never dropped, never destructive.

**`test_drive_sessions`** — one per assigned drive. Links (`service_session_id`,
`job_card_id`, `queue_id`, `worker_id`, `branch_id`), snapshots (`worker_name`,
`customer_name`, `bike_model`, `bike_registration`), `assigned_by_admin_id`,
timestamps (`assigned_at` / `started_at` / `ended_at`), `status`
(`assigned|running|completed|cancelled|failed`), start/end lat-lng, the
backend-computed metrics (`total_distance_km`, `total_duration_seconds`,
`moving_duration_seconds`, `stop_duration_seconds`, `average_speed_kmh`,
`max_speed_kmh`, `stop_count`, `point_count`), `route_image_path` /
`route_image_url`, `notes`.

**`test_drive_points`** — every submitted GPS point: `session_id`, `sequence_no`,
`latitude`, `longitude`, `timestamp` (device clock, naive UTC), `speed_kmh`
(device), `computed_speed_kmh` (backend dist/Δt), `accuracy_meters`, `heading`,
`altitude`, `source`, `is_valid`, `validation_error`. **Invalid points are kept for
audit but excluded from metrics and the route.**

**`test_drive_stops`** — detected stop events: `session_id`, `start_time`,
`end_time`, `duration_seconds`, `latitude`, `longitude`, `point_count`,
`radius_meters`, `address` (reverse-geocode reserved for future).

---

## 5. API list (`/api/v1/test-drives`)

> **Route order is deliberate:** the static `GET /mine/active` is declared **before**
> the dynamic `GET /{session_id}` so "mine" is never captured as a session id.

### Admin (`require_admin`)
| Method | Path | Purpose |
|---|---|---|
| POST | `/assign` | Create a drive on a **completed** job (`service_session_id` or `job_card_id`, optional `worker_id`, `notes`) |
| GET | `` (list) | Filterable: `status`, `worker_id`, `job_id`, `date_from`, `date_to` |
| GET | `/{id}` | Session + stops + point_count |
| GET | `/{id}/points` | All stored points (valid + invalid) |
| GET | `/{id}/summary` | Session + stops |
| GET | `/{id}/route-image` | Generates on first request, then serves the cached PNG |
| POST | `/{id}/route-image/regenerate` | Force-rebuild the PNG |
| POST | `/{id}/cancel` | Cancel an assigned/running drive |

### Worker (`require_worker`, ownership-checked)
| Method | Path | Purpose |
|---|---|---|
| GET | `/mine/active` | The worker's assigned/running drive (or null) |
| POST | `/{id}/start` | Begin (requires an initial GPS fix) |
| POST | `/{id}/points` | Batch-submit points `{points:[…]}` |
| POST | `/{id}/complete` | Finish → triggers metric + stop computation |

**Enforced rules:** assign only when `ServiceSession.status == completed` (else 409);
only the assigned worker can start/post/complete (else 403); one **running** drive
per worker; one **active** drive per job; a completed session rejects new points
(409); start requires an initial location fix.

---

## 6. GPS validation rules (`backend/app/utils/geo.py`)

A point is marked `is_valid = False` (kept for audit, excluded from metrics) when:

- **lat/lon out of range** — latitude ∉ [-90, 90] or longitude ∉ [-180, 180].
- **missing timestamp** — handled gracefully (falls back to server time on ingest;
  a missing device clock never blocks ingestion).
- **implausible speed jump** — segment speed from the previous valid point exceeds
  `MAX_PLAUSIBLE_SPEED_KMH = 140` km/h → `validation_error = implausible_speed_jump`.

A point stays **valid but flagged** when:

- **low accuracy** — `accuracy_meters > LOW_ACCURACY_THRESHOLD_METERS (50)` →
  `validation_error = low_accuracy`. It still counts toward metrics and is drawn,
  but it is surfaced to the admin as a quality warning.

**Invalid points are always preserved** in `test_drive_points` for audit.

---

## 7. Metric rules (backend = source of truth)

Computed in `utils/geo.summarize()` on `POST /complete`, from **valid** points only:

- **Total distance** — Σ Haversine distance between consecutive valid points (km).
- **Moving duration** — Σ Δt over segments where speed ≥ the stop threshold.
- **Stop duration** — total duration − moving duration (all non-moving time).
- **Average speed** — `total_distance_km / moving_hours` (km/h).
- **Max speed** — max of valid device/computed speeds (km/h).
- **Stop count** — number of detected stop **events** (≥ 60 s clusters; see §8).

> Note: short pauses (< 60 s) add to **stop duration** but do not create a stop
> **event/marker** — intentional, so brief lights/junctions don't clutter the map.

---

## 8. Stop detection rule

A **stop event** is recorded when the vehicle is, for a sustained period:

- **speed below** `STOP_SPEED_THRESHOLD_KMH = 2` km/h, **and**
- **within** `STOP_RADIUS_METERS = 30` m of the cluster, **and**
- **for at least** `MIN_STOP_SECONDS = 60` seconds.

(A single zero-speed point is never a stop — it must be a sustained cluster.)
A stop of **≥ 300 s (5 min)** is additionally flagged as a **LONG STOP**.

---

## 9. Route image (`backend/app/services/test_drive_image_service.py`)

- **Size:** 1080 × 1440 PNG (vertical mobile-report).
- **Background:** OSM tiles, **dark-styled** with a pure-PIL luminance colorize
  (`apply_dark_map_style`): the brightest pixels (roads/labels) lift to a muted
  blue-gray; land falls to navy; water/parks sink to deep navy. No numpy.
- **Route:** glowing bright cyan — outer GaussianBlur glow + core stroke + near-white
  centre highlight, rendered at 2× and downsampled (LANCZOS) for clean edges.
- **Markers:** **green** start, **black/dark** end (white outline), **red** stops
  (numbered; long stops get a warning ring).
- **Direction arrow:** white arrow with a translucent blue halo, placed near the end
  and rotated to the final route bearing.
- **Summary panel:** dark translucent rounded panel with a cyan accent line — title,
  bike (reg · model), job card, worker, customer, and the metric grid (distance,
  total/moving/stopped time, avg/max speed, stops, GPS points) + start→end times.
- Only **valid** points are drawn; generation requires **≥ 2** valid points.
- Stored at `media/test_drive_reports/{session_id}.png`; `route_image_path` /
  `route_image_url` are saved on the session.

**Endpoint behavior:** `GET /{id}/route-image` generates on first request (cached
after); not completed → **409**, fewer than 2 valid points → **400**, missing → **404**,
generation failure → **500 controlled** (logged, never a raw traceback). The image is
**admin-only and token-gated**, so the admin UI fetches it as a **blob → object URL**
(an `<img src>` cannot send the Authorization header).

---

## 10. Privacy / consent

The worker Test Drive page shows, verbatim:

> *"Location tracking is active only during the assigned bike test drive. Tracking
> stops when you complete the test drive."*

Guarantees (verified in `LiveWorkerTestDrive`):

- Tracking starts **only after** the worker taps **Start** (and ticks consent).
- Browser GPS permission is requested **only at Start**, never on page load.
- Tracking **stops immediately** on Complete and on component unmount
  (`watchPosition` is cleared; `visibilitychange`/`pagehide` flush pending points).
- **No background tracking** outside an active (assigned/running) session, and **no
  tracking after the session is completed**.
- The frontend never fabricates or computes final metrics.

---

## 11. Production notes

**OSM tile caching**

- Tiles are cached on disk at `media/map_tiles/{z}/{x}/{y}.png`.
- First generation of a route may download several tiles (up to a few dozen for a
  wide-area route); subsequent generations **reuse the cache** (0 new downloads).
- Downloads use a proper `User-Agent` and a small politeness delay.

**Tile usage policy** — the default `tile.openstreetmap.org` is fine for low-volume,
self-hosted use but is **not** for heavy production traffic. For production/high
traffic, point the tile URL at one of:

- a **self-hosted OSM tile server**, or
- a **tile provider with an allowed usage tier** (free or paid), or
- an **internal tile cache / proxy**.

Do **not** add Google Maps and do **not** hardcode paid map keys.

**Offline fallback** — if tiles are unreachable (after 2 failures it flips to offline
mode), the image still renders the real GPS route over a **dark schematic map** so a
report is always produced.

**Mobile GPS limitations** — browser GPS can be noisy/low-accuracy indoors or among
tall buildings; the worker page surfaces a weak-GPS warning. **The page must stay
open during the ride** — there is no background Service Worker tracking.

---

## 12. Known limitations

- **`pagehide`/`beforeunload` flush is best-effort** — a hard app kill mid-batch may
  lose the last ≤ 7 s of points; the short flush interval keeps loss tiny.
- **Browser GPS can be noisy** — low-accuracy points are flagged, not dropped.
- **Fixed route-image size** (1080 × 1440); templated sizes are not implemented.
- **No background Service Worker tracking yet** — the worker page must remain open.
- Tile fetches on a first wide-area generation are bounded by canvas size (~dozens),
  then cached.

---

## 13. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **No GPS / "permission denied"** | The worker declined location. Enable location for the site in the browser, then tap Start again. |
| **"Weak GPS" warning** | Accuracy > 50 m. Move to open sky; points are still recorded but flagged **LOW GPS ACCURACY**. |
| **Admin: "ROUTE IMAGE NOT READY"** | The drive isn't completed yet — the image is generated only after completion. |
| **Route image returns 400 / "fewer than 2 valid points"** | The drive has < 2 valid GPS points (e.g., started and ended immediately). No route can be drawn. |
| **Admin: "STALE TRACKING"** | A *running* drive has had no valid point for > 2 min (worker lost signal, closed the page, or stopped). |
| **Admin: "INVALID GPS POINTS"** | Points failed validation (out of range / implausible speed). They're preserved for audit but excluded from the route/metrics. |
| **Map tiles look blank/dark in the image** | Tiles were unreachable → offline schematic fallback; the route is still accurate. Configure a production tile source. |
| **Assign fails with 409** | The job isn't completed, or it already has an active test drive. |

---

## 14. Add-on — Approval & Worker Device Connection workflow

The original *worker-start → worker-complete* model was replaced by an **admin-assign →
worker-approve → admin-complete** model. **No silent tracking, and only an admin
completes a drive.**

**Flow:** admin assigns a completed job (`status=assigned`, `approval_status=pending_approval`,
`device_status=not_connected`) → the worker opens **Test Drive Approval**, sees the
request, taps **Approve & Connect Device** (the browser asks for GPS if needed and the
first fix is captured) → `POST /{id}/approve` flips the drive to `running` / `approved` /
`connected` and stores the seq-0 point → GPS streams via `POST /{id}/points` (each batch
is a **heartbeat**) → admin sees **Ongoing** (orange) + **Device Connected** → admin taps
**Complete Test Drive** → `POST /{id}/admin-complete` finalizes the authoritative metrics,
sets `status=completed` / `device_status=disconnected`, and records
`admin_completed_by/at`. The worker page detects completion (polling `GET /{id}/mine`, or
a `409` on its next `/points` batch), stops tracking, and shows the summary.

**Honest device state (browser reality):** a web app cannot force GPS permission, so
*Connected* means **worker approved AND a recent GPS heartbeat**. *Not Connected* = no
permission / denied / no heartbeat / **stale** (no heartbeat for > 2 min, derived at
serialize time). OpenStreetMap is only the map background — it never tracks the device.

**Worker cannot complete:** `POST /{id}/complete` now returns **403**. The worker page has
no Complete/End button — only **Approve & Connect Device** and **Reconnect Device**.

**Additive columns** on `test_drive_sessions` (string/timestamp; the `TestDriveStatus`
enum is untouched): `approval_status`, `worker_approved_at`, `worker_approved_device_id`,
`worker_approved_user_agent`, `device_connected_at`, `last_device_heartbeat_at`,
`device_status`, `admin_completed_by`, `admin_completed_at`. Migrated idempotently via
`ensure_test_drive_schema()`.

**New endpoints:** `POST /{id}/approve` (worker), `GET /{id}/mine` (worker self-read),
`POST /{id}/admin-complete` (admin). `POST /{id}/complete` (worker) → 403.

The **Completion Report / PDF** integration is unchanged — it still consumes **completed**
test drives only; ongoing/incomplete drives are never added as a final PDF page.

## 15. Correction — stop consistency + route-image quality + auto-generation

**Stop consistency (root-cause fix).** Previously `stop_duration` came from computed
displacement speed while `detect_stops` gated on the **noisy device speedometer**, so a
near-stationary ride could show *Stopped > 0* but *Detected Stops = 0*. Now (`geo.py`):
stop detection runs on **computed displacement speed** (radius-contained slow runs, ignoring
the device speedometer), and `stop_duration_seconds = Σ detected stop events`,
`moving = total − stop_duration`. **They can no longer contradict** — every ≥60 s same-place
run is exactly one stop event, shown identically in the drawer stop list, the red route-image
markers, the Completion Report stop table, and the PDF.

**Route image.** Auto-generated on **admin-complete** (eager, idempotent, never blocks
completion — lazy/manual `Regenerate` stays a fallback). Renders red **STOP i · m:ss** /
**LONG STOP · m:ss** duration labels, **Service Worker** and **Test Drive Worker** as separate
panel fields, a GPS-quality row (valid / invalid / low-accuracy), and a minimum ~300 m map
window so short rides stay readable. `service_worker_name` is snapshotted at assign from the
completed service session's worker. The admin drawer auto-loads the saved image on open.

---

*Module status: Phases 1–5 + Approval/Device-Connection + stop-consistency/route-image
correction. Backend authoritative; additive throughout; no Google Maps dependency.*
