# UX Audit — Camera Connection & Timer Connection
**Mode:** Product QA / UX validation only. No code was changed for this audit.
**Evidence:** 12 real-state screenshots in this folder (`01`–`12`), captured against the live backend (devices paired/unpaired/heartbeat/recording driven through the real API + real MQTT).

---

## 1. UX Score: **72 / 100**

| Dimension | Score | Notes |
|---|---|---|
| Visual hierarchy | 7/10 | Clear top-down scan; but empty slots dominate sparse fleets |
| Alignment & spacing | 8/10 | 8px grid holds; KPI/cards/drawer consistent within the page |
| Industrial dashboard feel | 7/10 | Glow-status cards land; REC state too subtle; badges over-used |
| Workflow speed | 7/10 | Pair/Test/Open ≤ 2 clicks; Remove is dangerously fast |
| Action noise | 5/10 | 4 buttons × every card; most belong in the drawer |
| Card design | 7/10 | Premium base; redundant signals; weak freshness display |
| Drawer design | 8/10 | Logical grouping; idle preview wastes the hero slot |
| Responsive | 7/10 | Laptop/tablet good (`09`,`10`); mobile title clipped (`11`) |
| Accessibility | 4/10 | Clickable divs, no keyboard path, sub-11px type |
| Data truthfulness | 6/10 | “Total Cameras = 6” with 0 paired (`01`) — counts bays |

**Verdict:** strong structural foundation (grid + drawer + status-glow is the right pattern), held back by action noise, redundant status signals, a misleading KPI, no fleet-scale tooling (search/filter/sort), and a destructive action with zero friction.

---

## 2. Top 20 design problems (evidence in parentheses)

1. **KPI lies in the empty state** — “6 TOTAL CAMERAS / 0 Online” when zero cameras are paired (`01`); the tile counts *bays*, not cameras.
2. **Remove is one click, unconfirmed**, and sits adjacent to Edit on every card — a slip unpairs a production camera (`03`).
3. **Action noise:** 4 buttons repeated on every card (`03`,`09`); Test/Reconnect are occasional ops, not per-card-always ops.
4. **Empty slots have equal visual weight to real devices** — with 1 paired device the page reads as “a wall of dashed boxes” (`02`, `07`).
5. **Triple-redundant status:** dot + HEALTHY badge + green border glow all encode the same bit.
6. **RECORDING — the most important live state — is the subtlest element** on the card: a small `⬤ LIVE` inside the spec strip (`04`).
7. **RTSP “● Configured” wastes a prime card slot** on a static config fact rather than a live signal.
8. **“Last seen” is buried in the footer** beside the buttons; it’s a primary monitoring signal; it wraps awkwardly on mobile (`11`).
9. **Two edit surfaces:** the pair-modal still contains a dead “edit” branch while the drawer is the real editor — code and concept debt.
10. **Mobile (390px): the page title clips under the topbar**; eyebrow cut off (`11`).
11. **No search / filter / sort** — unusable at the stated 50-bay scale; offline cameras don’t bubble to the top for attention.
12. **Timer page mixes a word (“Running”) into the numeric KPI row** (`07`); broker status is infrastructure, not a fleet KPI.
13. **No loading skeletons** — cards pop in after the first poll.
14. **Test feedback is toast-only**, far from the clicked card; the returned latency/resolution/fps is discarded unless the drawer happens to be open.
15. **Duplicated affordance:** whole card opens the drawer *and* an Edit button opens the drawer; no chevron/affordance hint.
16. **Accessibility:** cards are clickable `div`s (no role/tabindex/keyboard), icon-only close lacks a label, 9–10.5px type below readable floor.
17. **Drawer Save is always enabled** — no dirty-state, no IP/RTSP validation; Save with no changes still fires a PUT.
18. **Idle drawer wastes its hero slot** on a “NO ACTIVE FEED” placeholder before the information a technician actually came for (`06` vs idle).
19. **Three KPI dialects in one product:** ops-kpi (new pages) vs stor-kpi (Storage) vs the Live-Bay-Dashboard hero band (`12`) — the product no longer feels like one system.
20. **Breakpoint cliff at 1480px:** common 1440px laptops get 2 ultra-wide stretched cards instead of comfortable 3 (`09` is fine at 1366, but 1440–1479 is the worst case).

---

## 3. Top 20 improvements (mapped 1:1)

1. KPI = **paired camera count**, with “X of 6 bays paired” as the subtitle.
2. **Two-step Remove** (confirm dialog) and relocate Remove into the drawer’s danger zone.
3. Card keeps **one quick action (Test) + “Details ›”**; Reconnect/Edit/Remove live in the drawer.
4. Collapse unpaired bays into a **compact “Unpaired bays” strip**: `BAY 04 · BAY 05 · BAY 06 [Pair…]`.
5. **Badge only for exceptional states** (UNREACHABLE / DISABLED); healthy = dot + glow only.
6. **REC becomes a red pulsing corner ribbon** on the card + red ring on the thumbnail area.
7. Replace the RTSP slot with **STREAM (live/idle)** or **UPTIME** — live signals only on cards.
8. **Freshness chip top-right** of every card (“● 12s”), color-graded by age.
9. **Modal = pair-only**; delete its edit branch.
10. Fix the **mobile topbar offset** (content padding under fixed header).
11. **Toolbar row:** search box + status filter chips (All / Online / Offline / Recording / Unpaired) + “attention sort” (offline first).
12. **MQTT becomes a slim status strip** above the timer grid (broker · prefix · 1s-publisher state), not a KPI tile.
13. **Skeleton cards** on first load.
14. **Inline test result** on the card (small latency/fps chip for ~6s) in addition to the toast.
15. Single affordance: card click opens drawer; footer shows **“Details ›”** hint; drop card-level Edit.
16. **Keyboard + ARIA:** role=button, tabindex=0, Enter/Space, aria-labels, minimum 11px type.
17. **Dirty-state Save** (disabled until change) + IP/URL validation in the drawer.
18. **Adaptive drawer hero:** live feed status hero only while recording; idle → compact status strip with Connection section first.
19. **One KPI component product-wide** — migrate Storage Management tiles to the ops-kpi pattern.
20. **`repeat(auto-fill, minmax(340px, 1fr))`** grid — no breakpoint cliffs at any width.

---

## 4. Wireframe — ideal Camera Connection

```
┌────────────────────────────────────────────────────────────────────────────┐
│ CAMERA CONNECTION                                       [ + Pair New Camera ]
│ Manage and monitor all bay cameras.                                          
│──────────────────────────────────────────────────────────────────────────────
│ ┌ 4 ───────────┐ ┌ 3 ● ─────────┐ ┌ 1 ──────────┐ ┌ 1 ⬤REC ─────┐          
│ │ PAIRED       │ │ ONLINE       │ │ OFFLINE      │ │ RECORDING   │          
│ │ of 6 bays    │ │              │ │ needs attn   │ │ live now    │          
│ └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘          
│──────────────────────────────────────────────────────────────────────────────
│ [🔍 Search bay / camera / IP…]   (All)(Online)(Offline)(Recording)  ⇅ Attention
│──────────────────────────────────────────────────────────────────────────────
│ ┌─ CARD (offline first when attention-sorted) ──────┐ ┌─ CARD ──────────┐  
│ │ ● Bay 03 Camera          [UNREACHABLE]   ● 3h     │ │ ● Bay 01 ┌─REC─┐│  
│ │   CAM-03 · BAY 03                                  │ │   CAM-01 └─────┘│  
│ │   IP 192.168.1.103      STREAM idle                │ │   IP …  STREAM ▶│  
│ │  ───────────────────────────────────────────────   │ │  ───────────────│  
│ │   [ Test ]                            Details ›    │ │  [ Test ] Det.› │  
│ └────────────────────────────────────────────────────┘ └─────────────────┘  
│ UNPAIRED BAYS ─ BAY 04 · BAY 05 · BAY 06                    [ Pair a bay… ] 
└────────────────────────────────────────────────────────────────────────────┘
  Drawer (on card click): status header → ⬤ LIVE hero (only when recording)
  → CONNECTION (editable, validated) → CREDENTIALS → HEALTH (test results)
  → HISTORY → footer: [Reconnect] [Restart]   ····   [Remove ⚠ 2-step] [Save*]
                                                            (*enabled when dirty)
```

Timer Connection mirrors this with: MQTT status strip above the grid, FW/topic/heartbeat specs, OTA in the drawer firmware section.

---

## 5. Component hierarchy (target)

```
LiveCameraConnection
├─ OpsPageHead (title · sub · PairNewCamera)
├─ OpsKpiRow (Paired / Online / Offline / Recording)      ← truthful counts
├─ OpsToolbar (SearchInput · StatusChips · AttentionSort) ← NEW
├─ OpsCardGrid (auto-fill minmax 340px)
│   └─ CamCard (dot+glow · name · FreshnessChip · RecRibbon
│              · specs[IP·STREAM·UPTIME] · [Test] · Details›)
├─ UnpairedStrip (compact bay chips + Pair)               ← NEW (replaces slot cards)
├─ CamDrawer (status head · adaptive hero · Connection* · Credentials*
│             · Health · History · footer[Reconnect·Restart | Remove⚠ · Save*])
├─ ConfirmDialog (destructive actions)                    ← NEW (shared)
├─ CamModal (pair-only)
└─ Toast
```

## 6. Navigation flow

```
Sidebar → Camera Connection
   ├─ scan KPIs → anomaly? → filter chip (Offline) → card → Drawer → Reconnect/Test → resolved
   ├─ new device → [Pair New Camera] → modal (bay select → fields) → card appears online on first heartbeat
   ├─ routine check → search bay → card → [Test] → inline latency chip + toast
   └─ decommission → card → Drawer → danger zone → Remove → ConfirmDialog → unpaired strip grows
```

---

## 7. Redesign plan (NOT implemented — awaiting approval)

| Phase | Scope | Risk |
|---|---|---|
| **P1 — Truth & safety** | Fix KPI semantics (#1), ConfirmDialog for Remove (#2), modal pair-only (#9), mobile topbar fix (#10) | Low |
| **P2 — Card calm-down** | One action + Details› (#3,15), badge only when exceptional (#5), REC ribbon (#6), freshness chip (#8), STREAM slot (#7), unpaired strip (#4) | Medium |
| **P3 — Fleet scale** | Toolbar: search/filters/attention-sort (#11), auto-fill grid (#20), skeletons (#13), inline test chip (#14) | Medium |
| **P4 — Drawer & consistency** | Dirty-state Save + validation (#17), adaptive hero (#18), MQTT strip on timer page (#12), Storage KPIs → ops-kpi (#19), ARIA/keyboard (#16) | Low |

Every phase ships with a refreshed screenshot gallery of all states (the standing rule: **no UI change is “done” without state screenshots**).
