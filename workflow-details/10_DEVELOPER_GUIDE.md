# 10 — Developer Guide

> For a developer who just joined. Read this top-to-bottom once, then keep it open.
> Companion deep-dives: [01 Architecture](01_SYSTEM_ARCHITECTURE.md) ·
> [03 Workflow Engine](03_COMPLETE_WORKFLOW_ENGINE.md) · [05 Database](05_DATABASE_DOCUMENTATION.md) ·
> [07 Folder Structure](07_FOLDER_STRUCTURE.md) · [08 API](08_API_DOCUMENTATION.md).

---

## 1. Where to start (read in this order)

1. [11_PROJECT_OVERVIEW_FOR_BEGINNERS.md](11_PROJECT_OVERVIEW_FOR_BEGINNERS.md) — what the product does.
2. [01_SYSTEM_ARCHITECTURE.md](01_SYSTEM_ARCHITECTURE.md) — the moving parts and how they connect.
3. [backend/app/services/workflow_engine.py](../backend/app/services/workflow_engine.py) — **the single most important file**; understand `emit()` and you understand the system.
4. [backend/app/main.py](../backend/app/main.py) — startup order, middleware, router wiring.
5. [frontend/js/api.js](../frontend/js/api.js) — how the UI talks to the backend (and the live-vs-demo split).
6. [05_DATABASE_DOCUMENTATION.md](05_DATABASE_DOCUMENTATION.md) — the 17 tables.

## 2. Run it locally

**Backend** (needs Python 3.11+, PostgreSQL 16, ideally Redis + FFmpeg):

```bash
cd backend
./setup_postgres.sh                 # creates the baywatch role + db (macOS/Homebrew)
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 run.py                      # → http://localhost:8000  (Swagger at /docs)
```

On first boot [seed.py](../backend/app/seed.py) creates 4 branches, the master/admin
logins, the Chennai crew and 8 bays — **only if the users table is empty**.

**Frontend** (no build step):

```bash
cd frontend
python3 serve.py                    # → http://localhost:7890
```

**Logins:** `master / master123` · `admin / admin123` · `worker / worker123`.
Customers are created as real work comes in (no seeded customer).

**Optional infra:** Redis (persistent timers — without it timers are in-memory and
lost on restart), FFmpeg (real recording — without it recordings are metadata-only),
Mosquitto (physical ESP32 timers), Google Drive creds (archival), MSG91 (SMS).
Everything degrades gracefully; `GET /health` tells you what's live. Or run the whole
stack with `docker compose up` in `backend/`.

## 3. The mental model

```
One admin action  →  one workflow event  →  cascade to every subsystem, in one DB txn
```

* **Routers** are thin: validate, check role, call a service, return the envelope.
* **Services** hold logic. State-changing job logic lives in **exactly one place**:
  `workflow_engine.emit()`. Don't change session/camera/recording/timer/bay state
  anywhere else — route it through an event.
* **Models** are plain SQLAlchemy. **Utils** are pure helpers (timer maths, IDs,
  signing, hashing).
* **Redis** holds only *active* timers; **PostgreSQL** holds everything permanent;
  **local SSD** holds video; **Drive** holds archived video.

## 4. How the frontend is wired (important, it's unusual)

* No bundler. [index.html](../frontend/index.html) loads React + Babel from CDNs and
  every `.jsx` as `<script type="text/babel">` **in a fixed order**. Files share code
  through `window.*` globals, not imports.
* Every portal tab renders `live ? <window.LiveX/> : <DemoX/>` where
  `live = BW_API.isLive()` (a JWT exists). **`Live*` components
  ([live/live.jsx](../frontend/live/live.jsx)) are the real product;** the demo
  components are an offline fallback.
* Real-time data: `useBWPoll(fn, deps, ms)` (interval; stops on 401/403) and
  `useBWSocket(path, onData)` (WebSocket; backs off, gives up on 4401/4403).
* Auth lives in **sessionStorage** (per tab). The role is decoded from the JWT
  (`roleOf()`), never trusted from stored user data.

## 5. How to add a new feature (recipe)

**Add a backend endpoint:**

1. Model: add/adjust a table in [backend/app/models/](../backend/app/models/) and
   export it in `models/__init__.py`. For a column on an existing table, also add it
   to the matching `ensure_*_schema()` so existing databases migrate on boot.
2. Schema: add a Pydantic request/response model in [backend/app/schemas/](../backend/app/schemas/).
3. Router: add the function to the right file in [backend/app/routers/](../backend/app/routers/),
   guard it (`Depends(require_admin)` etc.), return `ok(data, "message")`.
   New router file? Include it in [main.py](../backend/app/main.py).
4. If it changes job state, **don't** mutate rows directly — add/extend a branch in
   `workflow_engine.emit()` and call it from the router.
5. Audit it with `log_action(db, "MY_ACTION", entity_type, entity_id, user.id, …)`.

**Expose it to the UI:**

6. Add a one-line wrapper in [frontend/js/api.js](../frontend/js/api.js)
   (`myThing: () => request('GET','/api/v1/...').then(unwrap)`).
7. Build a `Live*` component in [live/live.jsx](../frontend/live/live.jsx) using
   `useBWPoll`/`useBWSocket`; attach it to `window`.
8. Wire it into the portal tab switch in the relevant `pages/*.jsx`, and add a
   `<script>` line for any new file in [index.html](../frontend/index.html) **after**
   everything it references.

**Add a real-time stream:** add a `build(db, payload)` in
[services/snapshots.py](../backend/app/services/snapshots.py) and a `@router.websocket`
in [routers/ws.py](../backend/app/routers/ws.py) with the right `roles=`.

## 6. Conventions that keep the system consistent

* **Response envelope** `{success, data, message}` everywhere — use `ok()`/`fail()`
  from [schemas/common.py](../backend/app/schemas/common.py); the frontend `unwrap()`
  depends on it.
* **IDs:** generate with [utils/ids.py](../backend/app/utils/ids.py) (`SS-`/`REC-`/`JC-`,
  derived from the max existing suffix — never row count, or you'll get PK collisions
  after a delete).
* **Auth:** prefer the convenience guards (`require_admin`, `require_master`,
  `require_worker`, `require_customer`). For per-object ownership, follow the
  `_can_access()` pattern in [routers/recordings.py](../backend/app/routers/recordings.py).
* **Never expose raw paths/URLs:** local SSD paths and RTSP URLs stay server-side;
  hand the browser HMAC-signed URLs ([utils/recordings.py](../backend/app/utils/recordings.py),
  [services/streaming_service.py](../backend/app/services/streaming_service.py)).
* **Catch device/IO errors:** recording, MQTT, Drive and notification calls are wrapped
  so they can never break a job (mirror this for any new external call).
* **Times:** store UTC (`utcnow()` in [models/base.py](../backend/app/models/base.py));
  the timer is timestamp-anchored so restarts don't lose state.

## 7. How not to break the system

| Risk | Rule |
|---|---|
| Job state corruption | Change session/camera/recording/timer/bay state **only** through `workflow_engine.emit()`. |
| PK collisions | Use `utils/ids.py`; never `count()+1` for IDs. |
| CORS / hidden 500s | Keep the catch-all error middleware registered **before** `CORSMiddleware` in main.py (CORS must stay outermost). |
| Frontend "component is undefined" | A file used a `window.*` global before its `<script>` loaded — fix the order in index.html. |
| Lost recordings | Never delete a local video before a **size-verified** Drive upload **and** a committed DB row (see `_upload_one`). |
| Schema drift on existing DBs | New column → also add it to the relevant `ensure_*_schema()`. |
| Cross-role auth bleed | Keep auth in **sessionStorage** and derive role from the JWT; don't move the token to localStorage. |
| Customer/worker data leaks | Always scope queries by `customer_id == me.id` / `worker_id == me.id`; never return bay/camera internals to customers. |
| Timer drift on devices | Never compute time on the ESP32; publish from the backend only. |

## 8. Debugging quick reference

| Symptom | Look at |
|---|---|
| Login works but a page is empty | Browser console; is `BW_API.isLive()` true? Is the `Live*` poll getting 401/403? |
| 403 storm in console | A poller is using a token whose role lacks that endpoint — the hook stops on 403 by design; check `app.jsx` role-vs-portal guard. |
| Timer resets after restart | Redis not running → `timer_backend:"memory"` in `/health`. Start Redis. |
| Recording is "unavailable" | FFmpeg not installed → `recording_engine:"unavailable"`. `brew install ffmpeg`. |
| Video won't play / 403 on stream | Playback token expired (TTL 2 h) or recording expired (410). Re-fetch `GET /recordings/{id}` for a fresh signed URL. |
| ESP32 stuck / wrong time | `mosquitto_sub -t 'bay/#' -v`; check `mqtt.connected` in `/health`; press Reconnect (republishes state). |
| Drive uploads not happening | `drive_configured:false` → set `GOOGLE_DRIVE_CREDENTIALS` + `GOOGLE_DRIVE_FOLDER_ID`. |
| Backend logs | Logger namespace `baywatch.*` (timer/workflow/recording/mqtt/scheduler/drive) prints to stdout. |

## 9. Testing a change end-to-end (manual)

1. Log in as admin → create a job (manual or PDF) → assign to an available bay.
2. START → confirm: timer ticks on the dashboard, `media/recordings/{SS}/` fills,
   `/ws/worker` updates the worker page, customer page shows the live feed.
3. PAUSE/RESUME → new `seg_*.ts` appears, timer freezes/resumes.
4. COMPLETE → `video.mp4` is produced, expiry set, bay freed; Work Completion shows
   the recording; Preview plays it (HTTP Range 206).
5. Storage Management → Sync Now (if Drive configured) → row goes `uploaded`, local
   folder removed, playback redirects to Drive.

## 10. Production checklist (from the code's own notes)

* Set a strong `JWT_SECRET`; reduce `JWT_EXPIRE_MINUTES`.
* Run real PostgreSQL + Redis; run FFmpeg on the host.
* Configure Mosquitto with auth; configure Google Drive service account.
* Encrypt `bay_cameras.password` at rest (noted in the model).
* Replace the simulated camera probe with a real RTSP/ONVIF check
  ([routers/cameras.py](../backend/app/routers/cameras.py) `_probe`).
* Switch the sweep loop to Celery-beat/APScheduler on a real cron if you need
  exact timing (today it's a 6 h daemon loop) and finish the SendGrid email send.
* Use Alembic migrations instead of `create_all` for schema changes.
