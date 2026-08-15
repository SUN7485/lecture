# PPTX v2 — "HTML = PPT" master plan

*Written 2026-08-14 after a full first-hand audit of the uncommitted PPTX work
(scene extractor, Python renderer, fidelity gate, OCR bundle, tests, evidence
dirs). Executed via /handoff missions (032+); Claude plans, calibrates and QCs;
the agent types. Supersedes every ad-hoc pptx script at repo root.*

---

## 1. The goal, made measurable

"100% HTML = PPT and the PPT is editable" is four testable promises:

1. **Never refuse.** Every deck the editor can display exports. No feature of a
   real lecture (SVG diagram, gradient cover, formula) may abort the export.
2. **Editable-first.** Text is native PowerPoint text (per-line boxes, real
   fonts, RTL flags), tables are tables, lists are lists, images are images,
   solid & gradient fills are native fills. Only the provably-unmappable
   becomes a picture at its exact bounds — and every such "bake" is enumerated
   in the export report, never silent.
3. **Measured, not assumed.** Every export is verified by rendering the
   candidate PPTX through **real desktop PowerPoint** (COM) and comparing
   per-slide against a **Chromium capture of the same HTML** — SSIM + pixel
   budget at *calibrated* thresholds, plus a geometry read-back audit. A slide
   that fails is auto-repaired by demoting the offending nodes to bakes and
   re-rendering (bounded loop). The file that lands on disk carries a per-slide
   verdict; "unverified" is a visible state, never a silent one.
4. **Forever.** A one-command corpus scorecard (real lectures + a calibration
   deck) gates every future change to the pipeline. Numbers, not vibes.

**Accepted limits (decided, do not relitigate):**
- Baked islands (SVG diagrams, filtered/blended elements) are pictures, not
  editable vectors. Converting SVG paths to native `a:custGeom` shapes is
  parked — huge complexity, poor editing value (vector spaghetti). Revisit only
  on real user demand.
- Verification requires desktop PowerPoint + system Python. Fine for
  LOCAL-FIRST. A machine without Office exports **unverified** with an honest
  banner (never refuses). Vendoring Python / porting the renderer to Node is a
  distribution-era decision, not now.
- Slide size stays the HTML canvas (950×650 px ≈ 9.90″×6.77″). No 16:9
  re-layout — different aspect ratio would break HTML = PPT by definition.

## 2. Current state (2026-08-14, all first-hand)

**What exists and is genuinely good:**
- `serializeForPptx()` (`src/editor.js:2688`, synced twin in `web/editor.js`) —
  versioned scene graph `lve.scene-graph` v1: browser-measured bounds, computed
  styles, **real Chromium line geometry** per text element
  (`Range.getClientRects`, coalesced into per-line runs), tables/lists/images
  with crop, RTL direction per run, and font resolution browser-alias → real
  Office face (Lyon LF faces by weight, Diodrum). Verified live by
  `test/electron-scene-preview.test.js` — the strongest real test in the suite.
- `tools/pptx/renderer.py` (scene path) — python-pptx native renderer: per-line
  non-wrapping editable text boxes, shapes/borders/shadows, tables, lists,
  lines, images; `rtl.py` sets OOXML `rtl=1` throughout; autofit disabled so
  PowerPoint can't reflow.
- `tools/pptx/render-preview.ps1` — **real PowerPoint COM** renders the
  candidate to per-slide PNGs at 1900×1300, with owned-PID cleanup. This is the
  correct ground truth and it works (PowerPoint 16 installed at
  `C:\Program Files\Microsoft Office\Root\Office16\POWERPNT.EXE`).
- `src/pptxFidelity.js` — orchestrator with staged pipeline, windowed SSIM,
  pixel-diff + heatmaps + region flood-fill, structural XML audit (JSZip),
  atomic temp→destination commit. Solid bones.
- Preview modal already shows PowerPoint's own renders of the candidate deck.

**What is broken or fictional (the root causes):**

| # | Root cause | Evidence |
|---|-----------|----------|
| R1 | **The gate never runs in production.** Export hardcodes `fidelityPolicy:'editable-best-effort'` (`src/main.js:555`) and `evidenceMode:'native'` (`main.js:535`); source-render, PowerPoint-render, SSIM/pixel and OCR stages all require `'full'` (`pptxFidelity.js:1667,1721,1763`). Nothing ever sets `'full'`. Every export ships a permanent `FIDELITY_EVIDENCE_DEFERRED` warning = "we didn't check", displayed as if it were a defect count. | agent audit §2, §6 |
| R2 | **All-or-nothing refusal.** Any SVG / gradient / filter / transform anywhere → scene `unsupported` → `validate_scene_graph` hard-fails the whole export (`renderer.py:1622-1638`). Real lectures always carry SVG figures and gradient covers (`_plan_dump.json` slides 7–8; Chp5 lectures). The client-side SVG bake exists but **hangs** (`verify-svgdebug.js` investigates it) and `rasterizeInlineSvgs` (`src/renderer.js:1573`) is dead code — never called. Python's cairosvg fallback is broken on this machine (missing `libcairo-2.dll`) and its last resort ships a **labeled placeholder** that the structural audit can't distinguish from a real image. |
| R3 | **No end-to-end run has ever produced evidence.** `ppt-inspection-bnb/` and `bnb_html_match/` are empty scaffolds, `source-bnb.pptx` is 0 bytes, root `lecture.pptx` contains zero slides. Cause: the Aug-7 "Electron runs as Node v20.18.0" blocker — **verified today to be an env leak** (`ELECTRON_RUN_AS_NODE` from the agent shell); from a clean shell `electron.exe --version` prints `v31.7.7`. The binary is fine. |
| R4 | **Impossible thresholds.** SSIM ≥ 0.9995, ≤ 0.02 % pixels at delta 8, ≤ 8×8 px region (`pptxFidelity.js:35-43`) — two different text rasterizers (Chromium vs Office) differ in antialiasing on every glyph edge; text-heavy slides can never pass. These numbers were never validated against a real run (R3), and are plausibly why the gate got demoted to warnings (R1). |
| R5 | **Fonts don't travel.** `fonts.py:embed_fonts` is only called from the dead legacy path (`renderer.py:1779`, after `main()`'s `return`), and its XML is wrong anyway (`<a:fontRef>` instead of `p:font` + `p:regular r:id`, no `embedTrueTypeFonts`, appended out of schema order). Exported decks depend on Lyon/Diodrum being installed. Unknown customer fonts hard-fail preflight instead of degrading. |
| R6 | **Dead weight & drift.** Two extraction formats (legacy `serializeLegacyPptxPlan` + scene graph), two unused OCR adapters (`ocr-winrt.ps1` with stale "this is invoked by the export path" docstring, `ocr.py`), unreachable legacy renderer tail (`renderer.py:1736-1790`), abandoned pptxgenjs experiments (+ dependency), `pptxExporter.js` stub with a test that targets it, ad-hoc root scripts, temp dirs never cleaned, preflight demands PowerPoint+Tesseract even for paths that use neither, OCR gate requires exact token order (one misread kills it). All uncommitted. No handoff mission ever covered pptx-export (028 was import). |

**Bottom line:** the architecture chosen is the right one — browser-measured
scene → native renderer → real-PowerPoint ground truth. The extraction layer is
verified good. But the proof engine is unplugged, the coverage has a hole the
size of every real lecture, and nothing has ever been measured end-to-end.
This is a wiring-and-calibration problem, not a rewrite.

## 3. Architecture decisions (locked)

- **D1 — Chromium is the only rasterizer.** All baking (SVG, filtered
  elements) happens via CDP element capture in the existing hidden
  source-render window — the same engine that produces the reference image.
  cairosvg / inkscape / placeholder tiers are deleted. No third renderer, no
  placeholder ever ships.
- **D2 — Degrade per element, never refuse per deck.** Scene v2 replaces
  `unsupported → error` with `renderAs:'bake'` per node. Linear/radial
  gradients map to **native `a:gradFill`** first (editable, exact for the
  common case); only true unmappables bake.
- **D3 — Deterministic gate, OCR retired from it.** The gate = pixel/SSIM
  (visual truth) + structural XML audit (editability truth) + geometry
  read-back (position truth, python-pptx re-opens the candidate and asserts
  every box within tolerance of scene bounds). OCR (bundled Tesseract) becomes
  a diagnostic CLI only — pixel diff already catches misplaced text without
  OCR's flakiness. `evidenceMode:'full'` becomes the default export path.
- **D4 — Self-healing, bounded.** Failing slide → map diff regions to scene
  nodes → demote intersecting nodes to bake → re-render → re-compare, max 2
  passes. The committed file always ends verified, or carries a visible
  per-slide "unverified" verdict. Never blocks the save.
- **D5 — python-pptx stays.** It works and gives raw lxml access for
  gradients/rtl/fonts. A Node-native OOXML writer is parked until distribution
  demands zero system-Python.

## 4. Phases & missions

> **RITUAL: no commit that touches the pptx pipeline without `node verify-pptx-corpus.js`
> green — paste the scorecard in the commit message.** Single deck: `node verify-pptx-corpus.js <deck.html>`.
> Exit 0 means every slide of every deck was measured against PowerPoint's own
> render and passed; nothing less.

> **2026-08-14 (user decision): all seven missions are handed off to a Claude
> Opus 5 executor session** — handoff files `.claude/handoffs/032…038-pptx-*.md`,
> one per phase, run strictly in order, `/qc` after each before the next starts.
> The formerly Claude-led phases (0, 2, 4) carry their full designs inline
> (exact algorithms, XML shapes, derivation formulas) so the executor computes
> instead of inventing.

### Phase 0 — First truth (Mission 032) — ✅ DONE 2026-08-14
The cheapest possible end-to-end run, before building anything.
1. Commit the entire WIP as a `wip/pptx-v2` baseline branch (20+ uncommitted
   files = one crash from gone).
2. Env guard: every Electron-launching driver clears `ELECTRON_RUN_AS_NODE`
   from the child env and asserts `process.versions.electron` after launch —
   fail loudly with the fix in the message.
3. Evidence retention: gitignored `.fidelity/` in-repo (last N runs: report
   JSON + renders + heatmaps + an `index.md` scoreline per run) instead of
   losing everything to `%TEMP%`. Wire the existing-but-never-called
   `disposeFidelityWorkDirectory` for the old location.
4. Run the **existing** pipeline with `evidenceMode:'full'`, thresholds in
   warn-only mode, on two real lectures (SVG temporarily doctor-rasterized so
   the deck passes validation — the one-off path that already exists).
- **Exit:** first-ever real `report.json` with per-slide SSIM/pixel numbers on
  real lectures, artifacts in `.fidelity/`, numbers recorded in SESSION_LOG.
  We finally know how far off we actually are.

### Phase 1 — Every deck exports (Mission 033) — ✅ DONE 2026-08-14
- Scene v2 (`schemaVersion:2`): `unsupported[]` becomes advisory; each
  affected node gets `renderAs:'bake'` + capture id. `validate_scene_graph`
  rejects only malformed geometry, never features.
- Chromium element capture in the hidden window: clip to node bounds, 2× scale,
  transparent background, correct z-interleaving with native neighbors; baked
  PNGs travel in the scene payload; dedupe identical captures by hash.
- Gradient → native `a:gradFill` (angle + stops from computed CSS); conic or
  otherwise unmappable → bake.
- Delete: cairosvg/inkscape/placeholder tiers, `rasterizeInlineSvgs` dead code,
  legacy renderer tail, `serializeLegacyPptxPlan`, pptxgenjs dependency + root
  experiment scripts, `pptxExporter.js` stub + its orphan test, `_fix_bake.py`,
  `analyze_plan.py`, `_plan_dump.json`, empty bnb scaffold dirs.
- Preflight tiering: native export requires only Python; PowerPoint/Tesseract
  requirements move to the verification stage; no Office → export completes
  "unverified" with honest banner.
- **Exit:** the whole corpus (Chp5-Lec32/33, the 26-slide fixture, the 2.9 MB
  `source-bnb.html` stress deck, the LECTURE_PROMPT spec deck) exports with
  zero refusals, zero placeholders; report lists every baked node per slide.

### Phase 2 — Calibrate & arm the gate (Mission 034)

**FROZEN THRESHOLDS (2026-08-14), derived from `test/fixtures/calibration-baseline.json`:**

| threshold | value | derivation |
|---|---|---|
| `pixelDelta` | **24** | fixed by design — 8 counts every antialiased glyph edge |
| `ssim` | **0.8487** | `min(observed) − 0.005` = 0.853776 − 0.005 |
| `pixelMismatchPercent` | **8.45** | `max(observed) × 1.5` = 5.6301 × 1.5 |
| region size | **advisory** | one Arabic line rasterised twice is always one big region |
| geometry | **0.75 px, hard fail** | position is renderer-controlled; table height exempt (PowerPoint owns row heights) |

Distribution over 14 calibration slides × 3 runs (42 observations, **exactly
deterministic** — largest SSIM spread across runs `0.000e+0`):
`ssim` min 0.853776 / median 0.966945 / p95 0.991079 / max 0.994562 ·
`mismatch%` min 0.1878 / median 1.3162 / p95 3.4236 / max 5.6301.

The plan originally guessed a 0.96–0.985 floor and proposed clamping to 0.95 /
3.0 %. Measurement disagreed: dense Arabic text scores 0.8538 / 5.63 % with
identical fonts and geometry proven exact to 0.75 px, and a plain 4-line slide
(`font-control-deck.html`) scores ~0.943 / 2.5 %. Clamping would fail known-good
content on every export. Two defects found while calibrating were **fixed, not
absorbed**: gradient boxes were silently dropped (17.89 % → 3.42 % on slide 9)
and an `<img>` with an SVG source crashed the renderer. Tightening these is
Phase 4's payoff — embedding the deck's real fonts removes the dominant
remaining per-glyph difference.

<details><summary>original Phase 2 plan</summary>
- Calibration deck: every feature in isolation (sizes/weights, mixed RTL+LTR
  lines, justified Arabic, letter-spacing, bullets, tables, borders/radius,
  shadows, gradients, images, one SVG bake).
- Run corpus 3×; derive thresholds from the score distribution of known-good
  slides with margin (expectation: SSIM floor ≈ 0.96–0.985, pixel budget at a
  raised delta ~24; **final numbers come from data, then freeze here**).
- Geometry read-back audit; retire OCR from the gate to
  `tools/pptx/diagnose-ocr`; make `evidenceMode:'full'` the export default;
  "deferred" stops counting as a warning — verified / unverified / failed are
  distinct states in UI and report.
- **Exit:** every corpus slide passes at frozen thresholds or is explained;
  thresholds documented in this file.
</details>

### Phase 3 — Self-healing export (Mission 035) — ✅ DONE 2026-08-15
- Diff-region → scene-node mapping (bounds intersection, non-text nodes first,
  then text clusters); demote → re-render → re-compare, ≤ 2 passes; residual
  failures commit with per-slide "unverified" verdict + side-by-side evidence.
- Slide content-hash cache: unchanged slides skip re-verification on re-export
  (COM render ~1–2 s/slide is the cost driver).
- **Exit:** seeded-mismatch test deck converges; corpus verdict all-green.

### Phase 4 — Fonts travel (Mission 036) — ✅ DONE 2026-08-15
- Rewrite `embed_fonts`: ECMA-376-correct `p:embeddedFontLst`
  (`p:font typeface` + `p:regular/p:bold/... r:id`), `.fntdata` parts,
  `embedTrueTypeFonts="1"`, correct element order in `presentation.xml`.
- fontTools pipeline: woff2 → decompress; CFF-OTF → quadratic TTF (Lyon/Diodrum
  are CFF; PowerPoint embeds TrueType outlines). Check `fsType` embedding bits
  and surface the license status honestly.
- Unknown customer fonts: preflight warns + maps to nearest installed face
  instead of refusing.
- **Proof:** embed a synthetic test font with distinctive glyphs → COM render
  shows those glyphs (pixel-distinct from any fallback), file opens with no
  repair prompt. That proves embedding without needing a second machine.
- **Exit:** corpus decks carry embedded fonts; proof test green.

### Phase 5 — The product face (Mission 037) — ✅ DONE 2026-08-15
- Preview modal: per-slide **side-by-side** (Chromium | PowerPoint) + heatmap
  toggle + verdict chip + baked-element badges. This *is* the "preview
  html = ppt" feature.
- Honest Arabic status line on completion («متطابق — تم التحقق من N شريحة،
  عنصران مطبوخان» style); doctor becomes a pre-export advisory, not a gate;
  temp cleanup; CONTEXT.md Plans + KNOWN_ISSUES pruned (stale cairosvg entry
  out), SESSION_LOG updated.
- **Exit:** driven live via playwright (the LVE_OPEN recipe), screenshot proof.

### Phase 6 — Regression lock (Mission 038) — ✅ DONE 2026-08-15
- `verify-pptx-corpus.js` (verify-030 pattern): one command → per-deck,
  per-slide scorecard printed + written to `.fidelity/index.md`.
- `npm test` keeps the fast mocked suite + one real 3-slide end-to-end chain
  (~30 s). Delete remaining dead OCR adapters. SYNC-LAW check stays green
  (editor.js twins byte-identical — scene v2 edits hit both).
- Ritual documented here: **no pptx-pipeline commit without a corpus run.**
- **Exit:** scorecard command exists, documented, green.

## 5. Risks & honest expectations

- **Cross-renderer text AA** guarantees sub-pixel differences forever — that's
  why thresholds are calibrated, not 0.9995. Per-line boxes already neutralize
  reflow; residual risk is kashida/justification on justified Arabic — in the
  calibration deck from day one; worst case a stubborn line auto-bakes.
- **Bidi edge cases** (neutrals at RTL/LTR run boundaries) may order
  differently in PowerPoint's UBA vs Chromium's. Pixel gate catches it;
  calibration deck includes mixed-direction lines.
- **COM flakiness/perf**: owned-PID cleanup already exists; hash-cache (Phase 3)
  keeps re-exports fast. Full first verify of a 30-slide deck ≈ 1 min — fine
  locally.
- **CFF→TTF conversion** slightly alters glyph outlines (curve conversion) —
  irrelevant at text sizes, and the embed proof test measures the real result.
- **Editability granularity**: per-line boxes edit line-by-line, they don't
  reflow as paragraphs. That is the correct fidelity trade; a "paragraph mode"
  (merge lines, accept drift) is a possible later toggle, not in this plan.

## 6. Corpus (the decks every phase is judged on)

1. `Downloads\New folder\Chp5-Lec32-7-final.html` (real, SVG + gradients)
2. `Downloads\New folder\Chp5-Lec33-1.html` (real)
3. The 26-slide doctor fixture (`2.html` / `Chp1-Lec1-2.html`)
4. `bnb_html_match/source-bnb.html` (2.9 MB stress deck — keep the file, kill
   the scaffold dirs)
5. A fresh deck generated from `docs/LECTURE_PROMPT.md` (the clean-spec case)
