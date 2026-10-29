# Frontend Design System & CSS Architecture

> Result of the CSS audit performed during the Bay Management Fleet View build
> (June 2026), plus the rules that keep the UI consistent going forward.
> Files: [styles.css](../frontend/css/styles.css) ·
> [admin.css](../frontend/css/admin.css) ·
> [responsive.css](../frontend/css/responsive.css)

---

## 1. Audit report (measured, not assumed)

| Check | Finding | Verdict |
|---|---|---|
| Token duplication | 3 `:root` blocks found — styles.css:8 (core), admin.css:3669 (spacing), responsive.css:35 (motion). **Zero variables are defined twice** — they are complementary layers, not conflicts. | ✅ healthy |
| Chip/badge duplication | `.chip` + tones defined **once** (styles.css:220–241). No page redefines them. | ✅ healthy |
| Status dots | `.dot` + tones defined **once** (styles.css:190–214). | ✅ healthy |
| Missing semantic tones | `--info: #38bdf8` token existed with **no consumer**; `.dot.ok`, `.dot.ghost`, `.dot.info`, `.chip.info` did not exist (pages worked around it with `.dot.live` for green). | 🔧 **fixed** — added to the shared system in styles.css |
| Page-prefix sprawl | admin.css uses per-feature prefixes (`cam-`, `stor-`, `lja-`, `wap-`, `fv-`…). A previous "DESIGN SYSTEM PASS" (admin.css:3661) already unified KPI tiles + table rhythm across Camera/Timer/Storage. | ⚠️ acceptable — prefixes are *namespaces*, shared metrics come from tokens |
| Dead CSS | Demo-mode components (BAYS cards, demo queue) keep their classes in use; no orphan blocks found in spot checks. A full prune needs usage tracing across 12.6k JSX lines — deferred (low value vs. risk). | ⏸ deferred |

**Conclusion:** the codebase already had a single-source design system; the audit
prompt's worst-case (scattered duplicate badges) did not materialize. The fix was
surgical: complete the semantic tone set, add the new Fleet View block as a
documented component, and write this architecture down.

## 2. The layered architecture (as it exists)

```
styles.css   :root        ── DESIGN TOKENS (single source of truth)
                             surfaces --bg-0..4 · strokes --hair* · text --t-0..4
                             accent --amber* · semantic --ok/--warn/--danger/--info
                             radii --radius-* · shadow --shadow-card · fonts
styles.css   components   ── SHARED COMPONENTS: .chip(+6 tones) · .dot(+7 tones,
                             .pulsing) · .btn(+variants) · scaffold/typography
admin.css    :root        ── SPACING TOKENS: --sp-2..6 · --kpi-gap
admin.css    components   ── PAGE COMPONENTS (namespaced): cam- · stor- · lja- ·
                             wap- · fv- (Fleet View) … all consume tokens only
responsive.css :root      ── MOTION TOKENS: --tr-fast/mid/slow/--tr-ease + keyframes
responsive.css            ── RESPONSIVE OVERRIDES only (no component styling)
```

Load order in [index.html](../frontend/index.html): styles → admin → responsive,
so the cascade matches the layer order.

## 3. Shared component inventory

| Component | Classes | Defined at |
|---|---|---|
| Status chip | `.chip` + `.ok .warn .danger .amber .info .ghost` | styles.css:220 |
| Status dot | `.dot` + `.live .ok .warn .danger .amber .info .ghost` · `.pulsing` | styles.css:190 |
| Buttons | `.btn` + `.btn-amber .btn-ghost .btn-sm` | styles.css:246 |
| KPI tile | `.cam-kpi/.stor-kpi` (unified metric set) · `.fv-kpi` | admin.css:3680, fleet block |
| Fleet table | `.fv-table/.fv-row` (+ `.attn .sel .fv-head`, skeleton, empty state) | admin.css fleet block |
| Right drawer | `.fv-drawer*` (scrim, head, sections, actions) | admin.css fleet block |
| Bay-first picker | `.lja-bayres*` · `.lja-bayfirst-tag` | admin.css fleet block |

## 4. Status colour language (one meaning everywhere)

| Tone | Token | Means |
|---|---|---|
| green `ok` | `--ok` | online · available · synced · on-time |
| orange `amber` | `--amber` | running · recording · primary action |
| yellow `warn` | `--warn` | paused · temp cover · expiring |
| red `danger` | `--danger` | offline · unstaffed · overtime · attention |
| blue `info` | `--info` | maintenance · informational |
| grey `ghost` | `--t-3` | unpaired · idle · disabled |

## 5. Rules going forward

1. **Never hard-code a colour/spacing/radius** in a component — consume tokens.
2. **New status indicators must use `.chip`/`.dot` tones** — if a new tone is
   genuinely needed, add it once in styles.css next to the others.
3. Page components get a **namespace prefix** (`fv-`, `lja-`…) and live in
   admin.css; cross-page patterns (KPI tiles, table rhythm) reuse the unified
   metric set from the design-system pass.
4. responsive.css carries **behaviour only** (breakpoints, motion, touch).
5. A change to a shared component requires checking its consumers across all
   four portals (grep the class name in `frontend/`).

## 6. Changes made in this pass

* styles.css — added `.dot.ok`, `.dot.info`, `.dot.ghost`, `.chip.info`
  (completing the semantic set; `--info` finally has consumers).
* admin.css — appended the documented **Fleet View component block**
  (`fv-*`, `lja-bayres*`): summary KPIs, toolbar, dense operational rows with
  attention/selection states, loading skeletons, empty state, right details
  drawer, bay-first resolved panel, and 980px/640px responsive collapses.
  Tokens only — no raw hex values, spacing via `--sp-*`, motion via `--tr-*`.
