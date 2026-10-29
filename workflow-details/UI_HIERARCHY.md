# UI_HIERARCHY — Fleet View as the Primary Operational Page

> Component tree, layout contract and interaction model after Phases 3–4.
> Files: [frontend/live/live.jsx](../frontend/live/live.jsx) (`LiveBayManagement`,
> `FvDrawer`, `FvWorkerModal`, `LjaBayPicker`) ·
> CSS: Fleet block in [admin.css](../frontend/css/admin.css) ·
> tokens/components per [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

## Page structure (the fixed hierarchy)

```
.console-content (bounded flex column — THE page never scrolls on this tab)
├── section-head        "Bay Management · Fleet View" + REAL-TIME chip
├── .fv-kpis            6 KPI tiles (BAYS/AVAILABLE/RUNNING/MAINT/NO WORKER/ATTENTION)
├── .fv-toolbar         search · status filter · camera filter · sort · kbd hint
└── .fv-table  (flex:1, min-height:0)
    ├── .fv-row.fv-head     column headers (38px, never scrolls)
    └── .fv-scroll          THE ONLY scroll area
        └── .fv-row × N     uniform 54px rows (virtualized when N > 40)
```

**Structural stickiness:** KPIs, toolbar and table header are siblings *above* the
scroll container, so they cannot scroll away — no `position: sticky` fragility, no
layout shift (verified pixel-exact at 52 bays). On fluid/mobile (<1024px) the
scroller caps at `62vh` so the chrome stays reachable.

## Component tree

```
LiveBayManagement
├── useBWPoll(bayOperations + workers, 3 s)
├── derived: rows (search/filter/sort, attention-first) · summary KPIs
├── virtualization: ROW_H 54 · window when rows > 40 · ±8 overscan
├── keyboard: ↑/↓ select (scroll-follow) · ↵ open drawer
├── FvDrawer (right panel · Escape closes · 4 s self-refresh)
│   ├── BAY INFORMATION      name · channel · branch
│   ├── WORKER               avatar · TEMP badge · perf % · temp details
│   │   └── actions: Assign Primary | Replace Worker | Revert Now
│   ├── DEVICES              camera / timer / ESP32 chips + ids/IP/fw/topic
│   │   ├── MQTT broker      CONNECTED / DOWN row
│   │   └── actions: Test Camera · Test Timer · Restart ESP32
│   ├── CURRENT SERVICE      job card · status · remaining
│   ├── TODAY                jobs count
│   ├── RECENT SERVICES      last 8 completed (+OT)
│   ├── AUDIT TIMELINE       last 8 bay audit events
│   ├── BAY CONTROL          Maintenance ⇄ End Maintenance
│   └── DANGER ZONE          Disable Bay · Delete Bay → inline confirm
└── FvWorkerModal (mode 'primary' | 'temp' · Escape closes)
    └── same-branch worker pool · reason + date range (temp)
```

## Interaction contract

| Input | Behaviour |
|---|---|
| `↑` / `↓` | Move selection; scroller follows (works through the virtual window). |
| `↵` | Open drawer for selected bay. |
| `Esc` | Close confirm → drawer → modal (innermost first). |
| Hover | Row highlight (`--tr-fast`); selection ring `inset 2px amber`. |
| Click row | Drawer. |
| Search/filter/sort | Client-side over the polled snapshot; attention sort default. |

## States (all implemented)

Loading skeletons (`.fv-skel`, shimmer) · empty state (`.fv-empty`, "No bays match")
· attention rows (red tint, auto-top) · unstaffed (`NO WORKER` chip + ⚠ Unstaffed)
· per-device dot states · drawer skeleton while detail loads · danger confirm box.

## Where worker selection appears in the entire product

| Surface | Worker selection? |
|---|---|
| Job forms (manual + PDF) | ❌ — `LjaBayPicker` (bay only; 🔒 non-operational) + auto-resolved read-only panel |
| Queue drawer | ❌ — "Change Bay" only (worker follows) |
| Live Bay Dashboard | ❌ — display only |
| **Bay Management drawer** | ✅ Assign Primary / Replace / Revert — **the only place** |
