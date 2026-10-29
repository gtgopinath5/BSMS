# REMAINING_NON_DATABASE_ITEMS

> Honest list of every runtime value that is **not** yet sourced from PostgreSQL,
> with file path, line, reason, and a concrete migration plan. Per the rule:
> *"Do not hide or skip any remaining issues."*
>
> After the purification pass there is exactly **one** business-data item and a
> handful of UI-config placeholders. No demo arrays, demo stores, mock providers,
> or seeded runtime values remain (verified by repo sweep — see
> [FINAL_HARDCODE_AUDIT.md](FINAL_HARDCODE_AUDIT.md)).

## 1. Worker avatar photos — `localStorage` (the one business-data gap)

| Field | Value |
|---|---|
| **File / line** | `frontend/features/profiles.jsx:7` (`ProfileStore`, key `bw_photos_v1`) |
| **What** | Worker/admin avatar thumbnails stored as data-URLs in `localStorage` |
| **Reason it remains** | The `users` table has **no `photo_url` column**, and there is no file-upload/storage endpoint. Migrating requires schema + backend work, not just a code move. |
| **Runtime impact** | Low — `Avatar` falls back to initials when no photo exists; no business decision depends on a photo. It is the only browser-stored business-ish value left. |
| **Migration plan** | 1) `ALTER TABLE users ADD COLUMN photo_url VARCHAR;` (Alembic). 2) Add `POST /api/v1/workers/{id}/photo` (multipart) → store on SSD/Drive, save the URL. 3) Return `photo_url` from `/auth/login`, `/workers`. 4) `Avatar`/`AvatarUpload` read/write via the API; delete `ProfileStore` + `bw_photos_v1`. |

## 2. UI-config placeholders (not business data)

These are presentation defaults, not business records — they never represent a
real-world entity and are safe, but listed for completeness.

| Item | File / line | Reason | Plan |
|---|---|---|---|
| Worker profile contact fields (`Phone`, `Email`) shown as `—` | `frontend/pages/worker.jsx` (`ProfilePage`) | No `phone`/`email` columns on `users`. Identity (name/id/role/branch) and performance (jobs/score) ARE live from PostgreSQL; only contact/cert fields are placeholders. | Add `phone`, `email` (+ optional `joined_at`, `certifications`) columns to `users`; bind the fields. |
| Worker shift window (`08:00–17:00`) in sidebar | `frontend/pages/worker.jsx` (`WorkerPortal.shift`) | No shift/roster table; elapsed is clock-derived (real), start/end are a static window. | Add a `shifts`/roster table or branch config; read from API. |
| `ROLES` (app role catalog) and nav arrays (`ADMIN_NAV`, `MASTER_NAV`, `SIDE_NAV`, `CUSTOMER_NAV`, `CUSTOMER_NAV`) | `pages/screens.jsx`, page files | **App structure**, not business data — defines which tabs/capabilities exist in the UI. Legitimately static. | None — these are UI structure, not runtime business values. |

## Explicitly NOT remaining (resolved this pass)

- Hardcoded `BAYS` / `WORKERS` / `CAMERAS` / `TIMERS` arrays — **none exist**.
- Demo stores (`PartsStore`, `BayTimer`, `Workflow`, `QueueStore`, `BayAudit`) — **deleted**.
- Pre-login branch picker — now from **PostgreSQL** (`GET /api/v1/branches`).
- Worker navbar/profile identity — now from the **authenticated user record**.
- Customer status pill / notifications — now from **`/customer/*`**.
- `DEMO_CREDS` login pre-fill / seeded credentials — **removed**.
- Offline / anonymous / demo portal entry — **removed** (every portal needs a real JWT).

Nothing above blocks the "PostgreSQL single source of truth" goal at runtime: the
only outstanding item (worker photos) is cosmetic and gracefully degrades to initials.
