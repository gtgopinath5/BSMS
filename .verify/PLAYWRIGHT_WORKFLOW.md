# UI Verification Pipeline (Playwright)

Repeatable browser verification for Baywatch. One command, full report.

## Run it

```bash
# 1. backend up (if not already):   cd backend && python3 run.py
# 2. frontend up (if not already):  cd frontend && python3 serve.py
# 3. the pipeline:
NODE_PATH=/Users/gopinathgt/.npm/_npx/e41f203b7505f1fb/node_modules \
  node /Users/gopinathgt/bsms/.verify/verify_ui.js
```

Backend API suite (bay-first lifecycle, 17 checks, self-cleaning):

```bash
python3 /tmp/bw_verify.py        # canonical copy: .verify/bw_verify.py
```

## What the UI pipeline does

| Stage | Mechanism |
|---|---|
| Login | `POST /api/v1/auth/login` via fetch, token into per-tab `sessionStorage` (`bw_token`/`bw_user`) — matches `js/api.js`, skips the 3-screen entry flow. |
| Navigation | Clicks real sidebar links (`.side-link`), waits on real selectors (`.fv-table`, `.fv-drawer`, `.jf-modal`). |
| Assertions | 22 DOM checks: fleet rows, KPIs, attention-sort, unstaffed flags, drawer sections/actions, replace-worker modal, **no worker dropdown in job form**, bay-first picker + disabled unstaffed bays + auto-resolved worker panel. |
| Screenshots | `.verify/screenshots/{desktop,tablet,mobile}/NN-*.png` (1680×1050 · 1024×768 · 390×844). |
| JS error capture | `pageerror` + console `error` events (React DevTools/favicon noise filtered). |
| API error capture | `requestfailed` scoped to `localhost:7890/8000` (external font CDN aborts excluded). |
| Report | `.verify/reports/report.json` + `report.md`; exit code 0 only if every check passes. |

## Folder structure

```
.verify/
├── verify_ui.js          # the pipeline (this doc's single command)
├── debug_modal.js        # focused repro helper (modal rendering)
├── PLAYWRIGHT_WORKFLOW.md
├── screenshots/{desktop,tablet,mobile}/
├── reports/report.{json,md}
└── logs/
```

## Environment notes

* Playwright **1.60 (Node)** lives in the npx cache → hence the `NODE_PATH` prefix.
  Browsers in `~/Library/Caches/ms-playwright` (chromium-1223).
* Python playwright is **not** installed; don't `pip install` it just for this.
* Animations: wait ~700 ms after `waitForSelector` before screenshotting modals
  (`modalPop` is 240 ms); `innerText` returns **CSS-uppercased** text — write
  case-insensitive assertions.
* When adding checks: prefer `:has-text()` over `:text-is()` (whitespace-tolerant),
  and select elements by finding the `<select>` whose options match, then dispatch
  a bubbling `change` event (React listens on the root).
