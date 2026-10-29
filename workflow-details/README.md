# Baywatch Service OS — Technical Documentation

This folder is the complete, **implementation-derived** documentation set for the
Baywatch Service OS codebase. Every file, table, API path, framework and device named
here exists in the repository — nothing is invented or aspirational (where something
is partial or dormant, it is called out honestly).

## Read in this order

| # | Document | What it covers |
|---|---|---|
| 00 | **README** (this file) | Index + how the docs fit together. |
| 01 | [System Architecture](01_SYSTEM_ARCHITECTURE.md) | All 10 architecture layers (frontend, backend, DB, services, camera, timer, recording, Drive, MQTT, workflow engine) with Mermaid diagrams and end-to-end data flow. |
| 02 | [Frontend Workflow](02_FRONTEND_WORKFLOW.md) | Every page of all 4 portals — purpose, API calls, buttons, what each one triggers. Beginner-friendly. |
| 03 | [Complete Workflow Engine](03_COMPLETE_WORKFLOW_ENGINE.md) | All 21 workflows step-by-step, with the master end-to-end sequence diagram. |
| 04 | [Storage & Data Flow](04_STORAGE_AND_DATA_FLOW.md) | Hardcoded values, PostgreSQL/Redis/SSD/memory/Drive/MinIO maps — who creates/updates/deletes each. |
| 05 | [Database Documentation](05_DATABASE_DOCUMENTATION.md) | ER diagram + all 17 tables (columns, keys, FKs, connected APIs/pages/services). |
| 06 | [Project Frameworks](06_PROJECT_FRAMEWORKS.md) | Every framework/library actually used, plus an honest "NOT used" list. |
| 07 | [Folder Structure](07_FOLDER_STRUCTURE.md) | Annotated project tree + dependency graph + cross-file contracts. |
| 08 | [API Documentation](08_API_DOCUMENTATION.md) | Every REST/WS/HLS endpoint: method, URL, auth, in/out, tables, workflow triggered. |
| 09 | [External Device Integration](09_EXTERNAL_DEVICE_INTEGRATION.md) | CP Plus camera, ESP32 timer, MQTT, Google Drive, FFmpeg, NVR, MSG91 — connect/talk/store. |
| 10 | [Developer Guide](10_DEVELOPER_GUIDE.md) | Onboarding, run-local, add-a-feature recipe, conventions, how-not-to-break-it, debugging. |
| 11 | [Project Overview for Beginners](11_PROJECT_OVERVIEW_FOR_BEGINNERS.md) | Plain-language explanation for a newcomer / 15-year-old. |

## The one-paragraph summary

Baywatch Service OS is a two-wheeler service-centre platform. A **FastAPI** backend
(port 8000) owns all logic; a build-step-free **React 18 + Babel Standalone** frontend
(port 7890) renders four role portals (Master Admin / Admin / Worker / Customer). The
heart is the **workflow engine** ([backend/app/services/workflow_engine.py](../backend/app/services/workflow_engine.py)):
one admin action fires one event (`JOB_ASSIGNED/STARTED/PAUSED/RESUMED/COMPLETED`) that
cascades to the service session, the bay camera (RTSP→FFmpeg recording + live HLS), the
**Redis**-persisted countdown timer, the physical **ESP32** display (over **MQTT**),
the job queue, and customer notifications. Finished videos are archived to **Google
Drive** and auto-expire after 14 days. Everything is stored in **PostgreSQL** (17
tables) and degrades gracefully when any optional dependency (Redis, FFmpeg, MQTT,
Drive, SMS) is absent.

## Conventions used in these docs

* File references are clickable relative links, e.g.
  [backend/app/main.py](../backend/app/main.py).
* Diagrams are **Mermaid** (render on GitHub and most Markdown viewers).
* "Honest status" callouts flag anything partial, simulated, or dormant-until-configured
  so no one wastes time looking for code that isn't there.
