# Studio v3 — "The Studio disappears into the editor"

*Plan written 2026-07-06, after the v2 full-page Studio was judged bad. The engine
(pipeline, diagrams, cache, cost gating) survives; the shell is rebuilt from zero.*

---

## 1. Why v2 feels bad (honest diagnosis)

| # | Problem | Evidence in code |
|---|---------|------------------|
| 1 | **It's a mode, not a tool.** Full-screen takeover hides the (good) editor and re-renders slides as a scaled, static `srcdoc` iframe with absolutely-positioned "pins" — a degraded clone of what's sitting right behind it. | `studio.js` `renderCanvas()`/`drawPins()` — coordinate math, flicker guards, floating un-anchored chips |
| 2 | **The user operates a state machine.** Seven states with badges, stat cards that count states, batch buttons named after states ("توليد المعتمد (3)"). The user's mental model is *show me → yes/no*, not *advance items through a pipeline*. | `STATE_META`, `statCard()`, overview page |
| 3 | **The approval gate protects things that are FREE.** Diagrams, charts, and equations render locally in milliseconds at zero cost — yet v2 still forces suggest→approve→generate→ready→insert and literally shows *"لا معاينة بعد — التوليد بعد الموافقة فقط"*. Approving blind, for something that could have been shown finished, instantly, for free. The proposal-first rule exists to protect **image quota only**. | `renderInspector()` preview box; `pipeline.generate()` |
| 4 | **Editing is blind forms.** Diagram = a layout `<select>` + a pipe-separated textarea, no preview until regenerate — although re-rendering is free on every keystroke. | `#stu-layout`, `#stu-nodes` |
| 5 | **Fragile AI plumbing.** Slow reasoner, 4-slide chunks, failed batches silently skipped (`if (!r.ok) continue;` — those slides are just never reviewed and nobody is told), no cancel, no streaming, JSON failure = "try again". | `reviewLecture()`, `_reviewBatch()` |
| 6 | **Admin work pushed to the user.** A whole "الأشكال" tab + a manual "build references slide" button for something that should be automatic. | `renderFigures()` |
| 7 | **No point-of-work entry.** You cannot select a bullet list in the editor and say "make this a diagram". Every AI interaction requires the full-screen ritual. | — |

## 2. What stays (genuinely good, keep untouched)

- **Proposal-first for paid calls** — never spend an image call without an explicit, cost-labeled click.
- **Deterministic rendering** — LLM supplies content JSON only; `diagrams.js` / `charts.js` / MathJax draw. LLM never emits SVG.
- **Cache** (`<lecture>.enrich.json`, content-hash keyed) — reopen costs zero calls.
- **In-place figure lifecycle** — `data-ve-prop`, replace/retype/recaption/remove after insert.
- **Element-anchored extras** (`data-ve-src`), auto-renumbering «شكل N» in `_pushHistory`.
- **Brand theming** — palette + fonts flow into every generated visual.

## 3. North star

> **Grammarly for slides, not a Photoshop for suggestions.**
> The editor stays on screen and editable at all times. AI is a *layer*:
> a docked panel + ghost previews inside the real slides + a selection wand.
> Every free visual arrives already rendered; the only decision left is
> **أدرِج / عدّل / تجاهل**. Money is only ever spent by a button that says
> exactly what it costs.

No competitor (Gamma, Tome, Canva Magic, Beautiful.ai, Decktopus) has: Arabic-RTL-first
deterministic diagrams, zero-cost instant previews, working over the user's *own* HTML
files, or per-click cost transparency. That combination is the moat — v3 doubles down on it.

## 4. The design

### D1 — Kill the full page; dock a panel
`src/studio.js` (591-line takeover) is deleted. Replacement: a collapsible docked panel
(~380 px) beside the live editor. Suggestion cards grouped by slide, each with a real
thumbnail. Clicking a card scrolls the *real editor* to the slide. The meter lives in the
panel header, humanized: **"هذه الجلسة: مجاني بالكامل"** or **"٣ استدعاءات صور"**.

### D2 — Free-first rendering: *suggest = render*
The moment a suggestion arrives (from SUGGEST or REVIEW), diagrams/charts/equations are
rendered locally and the finished SVG is attached to the card. Cards show the actual final
visual, not a promise. Images show a styled prompt-card (prompt, style, aspect, cost label);
**Generate** stays the explicit paid action.

Externally the state machine collapses to two states: **مقترح (with preview) → على الشريحة**
(+ inline error on the card). Internally `pipeline.js` may keep its states; the UI never
shows them again.

### D3 — Ghost previews in the real slide
Hover/select a card → the actual figure node is temporarily inserted into the live editor
DOM through the *same* insert path used by Apply, with a `.ve-ghost` class (dashed
brand-color outline, 80 % opacity, «معاينة» ribbon). Editor scrolls to it.
**أدرِج** = remove ghost class + one history push (normal Ctrl+Z undoes it).
**تجاهل** = remove node. No iframes, no pins, no coordinate math — preview ≡ result by
construction.

New editor API: `insertGhost(p) / promoteGhost(p) / removeGhost(p)` built on the existing
`insertGenerated` / `insertGeneratedAsNewSlide` paths (ghosts excluded from save/export/
history the way `.ve-overlay` already is).

### D4 — The wand ✨ (point-of-work AI)
The editor already has a selection toolbar (`ve-toolbar`). Extend it with a ✨ menu:

| Selection | Action | Cost |
|---|---|---|
| bullet list / paragraphs | **حوّل إلى مخطط** — parse items → nodes *offline*, ghost preview instantly; optional "حسّن الصياغة" = 1 text call | free (opt. 1 call) |
| table | **ارسم رسمًا بيانيًا** | free |
| formula-ish text | **معادلة منسقة** (MathJax) | free |
| anything | **أضف صورة عن هذا** → prompt card in panel | paid on click |

Offline-first is the point: list→diagram works with **zero API calls** because the user's
own text becomes the nodes. This makes AI ambient instead of ceremonial.

### D5 — Diagram lab (signature feature)
Because rendering is free and instant:
- **Layout carousel**: render the *same* nodes in all 7 layouts as live thumbnails; click to
  switch. Nobody online has instant multi-layout preview for Arabic diagrams.
- **Node chips** instead of the pipe-textarea: add/remove/reorder chips, click a node *in the
  preview SVG* to edit its text in place, star = emphasis. Every change re-renders live.
- The raw textarea survives under "متقدم" for power edits.
- "Revise with note" (1 text call) stays for wording-level improvements.

### D6 — Image lab
- **Variant picker**: "ولّد نسختين" / "٤ نسخ" with exact cost in the label; grid → pick one,
  losers stay cached for later swap.
- **Style presets** aligned with the brand kit: photo / flat illustration / isometric /
  infographic (keeps the Arabic-text warning).
- **Prompt-assist chips** (لقطة أقرب، بدون أشخاص، إضاءة أدفأ…) instead of free-text-only.
- Aspect ratio still inferred from the slot rect; editable.

### D7 — Background, cancellable, honest review
- Review runs **in the background while the user keeps editing** — cards stream into the
  panel per batch (no modal takeover, so this is finally possible).
- Batches run in parallel (concurrency 2–3), with a visible **إيقاف** button
  (AbortController surfaced through IPC → `fetch` signal in `ai.js`).
- **No silent drops**: failed batches show as a "تعذّرت مراجعة الشرائح 9–12 — أعد المحاولة"
  chip instead of vanishing.
- JSON hardening in one place: strip fences → extract first `[...]` block → repair trailing
  commas → one automatic re-ask carrying the parse error → only then surface failure.
  Use `response_format: {type:'json_object'}` when the endpoint supports it.

### D8 — Zero admin
- Figures tab deleted. Auto-renumber already works; the «قائمة الأشكال» slide auto-updates
  on every insert/remove once it exists (toggle in panel footer).
- A small «الأشكال» popover in the panel footer shows the numbered table with jump links —
  informational, not a workflow destination.

### D9 — Testability
- `LVE_FAKE_AI=1` mock provider (canned JSON + a placeholder image data-URL) so the entire
  UX is drivable with zero keys — generalizes the `_injectExtra` idea.
- Playwright flows (per the house rule: `LVE_OPEN` + `window.__editor` + screenshots):
  suggest→ghost→apply→undo; wand list→diagram; review cancel; variant pick; cache reopen.

## 5. Architecture

```
src/studio.js  (deleted)
src/studio/
  panel.js          docked panel: cards, groups, meter, figures popover
  ghost.js          ghost insert/promote/remove (thin wrapper over editor APIs)
  wand.js           selection ✨ actions (offline parsers + panel handoff)
  diagramEditor.js  layout carousel + node chips + click-to-edit
  imageCard.js      prompt card, style presets, variants grid
src/enrich/pipeline.js   keeps engine role; changes:
  - auto-render free kinds at suggestion time (result attached immediately)
  - apply(p) = promoteGhost + insert; discard(p)
  - cancellation tokens through suggest/review/generate
  - parallel _reviewBatch with failure ledger (no silent continue)
src/enrich/ai.js   AbortSignal pass-through over IPC; json_object flag; (later: SSE streaming)
src/editor.js      .ve-ghost styles + insertGhost/promoteGhost/removeGhost; ✨ in ve-toolbar
```

## 6. Phases (each independently shippable)

**Phase 1 — The Flip** ✅ *SHIPPED & VERIFIED 2026-07-07*
Docked panel replaces the full page; free kinds render at suggest time; ghost previews;
two-state UI; humanized meter. Deleted `studio.js`; new `src/studio/panel.js`.
- Editor: `.ve-ghost`/`.ve-ghost-hidden` stripped from `_snapshot()`, `getCleanHtml()`,
  `slides()`, `figures()`, `_cleanClone()`; new `showGhost()`/`clearGhost()`; ghost CSS in
  the injected iframe sheet.
- Pipeline: `_renderFree()` (chart/diagram/equation, no meter) called from scan/suggest/
  review/init; `previewGhost()`/`apply()`/`discard()`/`_ghostTarget()`/`meterText()`.
- Renderer: `window.__revealInStage()` scrolls a ghost into view; button now `Studio.toggle()`.
- **Verified** via playwright-core Electron smoke (`scratchpad/smoke.js`) on Chp1-Lec1-2.html:
  panel opens with 2 rendered-preview cards at 0 calls (one from cache); ghost appears in the
  real slide; `ghostInSnapshot`/`ghostInExport` both **false** (no leak into history/save);
  apply → real numbered figure + history grows; undo removes it; fake diagram → new-slide
  ghost excluded from `slides()` → apply adds slide 26→27 with «شكل 1». Two screenshots looked
  clean.
- *Known limitation (pre-existing):* undo of an applied figure leaves the pipeline thinking
  `onSlide=true` until the panel is reopened (DOM/pipeline desync). Not a Phase-1 regression.

**Phase 2 — The Wand** ✅ *SHIPPED & VERIFIED 2026-07-07*
✨ on the selection toolbar: list→diagram, table→chart, formula-text→equation (all
offline), any-text→image handoff (paid on click).
- Editor: ✨ button on the non-image `ve-toolbar` (shown only when `Wand.actionsFor(el)`
  is non-empty); `_showWandMenu()`/`_closeWandMenu()` render an in-iframe menu (styled like
  `ve-palette`, stripped from snapshot/export/clean-clone; ignored by `_onDocClick`);
  public `ensureTargetId(el)` (stamps a stable `vw*` id) + `slideIndexOf(el)`.
- Wand (`src/studio/wand.js`): offline parsers — `listItems`/`splitLabel` ("عنوان: تفصيل"
  → {label, sub}), `looksLikeFormula`+`toLatex`, `extractTableData` reuse. `run()` = build
  spec → `Studio.ensureOpen()` → `Pipeline.wandProposal()` → `Studio.focus()`.
- Pipeline: `wandProposal({el,kind,spec,caption,why,applyMode})` — stamps target, replaces
  any prior non-onSlide proposal for it, `_renderFree`, `isWand` flag. `isWand` proposals
  survive rescan (scan's extras concat) and are skipped by the cache writer (ephemeral until
  applied). Insert uses the normal `applyMode:'after'` path (figure lands right after the
  source element, source kept).
- Panel: `ensureOpen()` (open only if closed — never re-inits an open session) and
  `focus(targetId)` (open card + pin ghost + scroll both panel & stage).
- **Verified** via playwright-core Electron smoke (`scratchpad/wand-smoke.js`) on
  Chp1-Lec1-2.html, key off (0 keys): ul→diagram gives 2 nodes, rendered SVG ghost in the
  real slide, `meter.glm/img` both **0**, panel+card auto-open; ghost absent from
  `getCleanHtml()`; apply → `figure.ve-slot[data-ve-prop]` right after the `<ul>`, figures
  grew, ghost gone; table selection offers only `chart`, list offers `diagram`+`image`.
*Done when:* select a bullet list → ghost diagram appears in-slide within 100 ms. ✓

**Phase 3 — Diagram lab** ✅ *SHIPPED & VERIFIED 2026-07-07*
Layout carousel, node chips, advanced textarea, revise-with-note.
- New `src/studio/diagramEditor.js` (`window.DiagramLab.mount(container, p, {commit, revise})`):
  7-layout **carousel** (each thumb = the same nodes rendered in that layout via
  `EnrichDiagrams.render`, click to switch); **node chips** — per-node label + optional sub
  inputs, ⭐ emphasis toggle, ▲/▼ reorder, ✕ delete (min 2 / max 8), ➕ add; **حسّن الصياغة**
  (one optional text call); **متقدم** `<details>` keeps the raw `title | sub` textarea.
  Live label typing fires `commit` (preview only, keeps focus); structural edits repaint the
  lab then commit. `container` stops click propagation so a rebuilt-on-click thumb can't
  collapse the card.
- Panel: `editorBox` diagram branch delegates to `DiagramLab` (old select+textarea kept as
  fallback); new `commitFree(p)` re-renders locally and patches ONLY `.sd-prev` + ghost (or the
  on-slide figure) in place — never rebuilds the card, so chips keep focus, 0 calls;
  `runRevise(p, note)` = the single `P.generate(p, note)` wording call.
- CSS `.dl-*` in styles.css. Bug fixed: the card's open/close click handler now ignores
  `.sd-edit`, and the lab root stops propagation — clicking a carousel thumb (a plain div that
  paint() detaches mid-click) was collapsing the card.
- **Verified** via `scratchpad/lab-smoke.js` (playwright-core, keys off): lab mounts with 7
  thumbs + chips; click «هرم» thumb → `spec.layout='pyramid'`, highlight moves, ghost
  re-renders, card stays open, **0 calls**; live label edit, add-node, ⭐ emphasis, reorder all
  mutate the spec and re-render at **0 calls** (meter "مجاني بالكامل ✓"); advanced textarea
  parses `أ|تفصيل أ` → nodes+subs. Screenshot shows carousel + chips rendering cleanly.

**Phase 4 — Image lab**
Variants grid with exact cost labels, style presets, prompt chips, cached losers swap.

**Phase 5 — Engine hardening**
Cancel everywhere, parallel review, visible failure ledger + per-range retry, JSON repair
pipeline, `LVE_FAKE_AI` mock, Playwright suite over all flows.

**Phase 6 — Beyond visuals (opt-in «مستشار المحاضرة»)**
Overcrowded-slide split suggestions, title/wording polish, speaker notes, quiz slide —
each proposal-first with ghost previews, same panel. Expands the moat once the core is
flawless.

## 7. Non-goals

- No WYSIWYG drag-editing of generated SVG internals (chips + carousel cover 95 %).
- No LLM-emitted SVG, ever.
- No cloud accounts / telemetry — the app stays local-first.
- No new framework: same vanilla-JS + IIFE conventions as the rest of the codebase.
