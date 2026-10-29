# 02 — SESSION / LOCAL STORAGE AUDIT

> Every `localStorage` / `sessionStorage` use in the frontend, classified Allowed vs
> Removed. Source: `grep -rn "localStorage|sessionStorage" frontend/`.

## ALLOWED (kept — not business data)

| Key | Storage | File | Why allowed |
|---|---|---|---|
| `bw_token` (JWT) | **sessionStorage** | [api.js:25,50](../../frontend/js/api.js#L25) | auth token; per-tab isolation (3 roles in 3 tabs) |
| `bw_user` (`{id,name,role,branch_id}`) | sessionStorage | api.js:50 | session identity — mirrors JWT claims; `roleOf()` decodes the JWT itself, so this is a convenience cache, not authoritative business state |
| `bw_api_base` | localStorage | [api.js:12](../../frontend/js/api.js#L12) | backend base URL (config) |
| notifications `SEEN_KEY` | localStorage | live.jsx:4830 | "last viewed" timestamp — a UI read-marker (preference) |

## REMOVED (business data — must come from PostgreSQL)

These all live in the **demo/offline components**, which after the refactor are
**unreachable** (a portal now requires a real JWT). They are deleted.

| Store | File | Held (business data) | PostgreSQL source now |
|---|---|---|---|
| `BayTimer` | features/baytimer.jsx | live countdown / timer state | Redis timer + `GET /api/v1/bay-dashboard` |
| `PartsStore` | features/partsstore.jsx | parts master | `GET /api/v1/parts` |
| `Queue` store | features/queue.jsx | job queue | `GET /api/v1/queue` |
| `BayMgmt` audit | features/baymgmt.jsx | bay audit trail | `GET /api/v1/platform/activity` |
| `Workflow` | features/workflow.jsx | job lifecycle state | workflow engine (PostgreSQL) |

## REVIEW

| Store | File | Note |
|---|---|---|
| Photo store (`bw_photos`) | features/profiles.jsx | worker photo thumbnails as data-URLs. Worker photos are **not yet a database column** — listed in [REMAINING_HARDCODED_ITEMS.md](../../REMAINING_HARDCODED_ITEMS.md) with the migration path (add `users.photo_url` + upload endpoint). Until then it is the only client-stored "business-ish" data, and it is non-critical (avatar fallback is initials). |

## Rule going forward

Business data is **never** written to `localStorage`/`sessionStorage`. Only: JWT,
session identity, `bw_api_base`, theme, and UI read-markers. Everything else is fetched
from the API on mount and re-fetched on refresh (no client cache of business state).
