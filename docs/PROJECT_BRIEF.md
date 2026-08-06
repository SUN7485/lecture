# Lecture Visual Editor (LVE) — Full Project Brief

*Written 2026-07-17 for sharing with external AI models. Self-contained: assumes zero prior context. Compiled from `CONTEXT.md`, `SESSION_LOG.md`, `KNOWN_ISSUES.md`, `docs/resell-study.md`, git history, and the codebase itself.*

---

## 1. What this is

**Lecture Visual Editor** — a PowerPoint-style visual editor for **HTML slide decks**, built for **Arabic RTL lectures**. Open any lecture `.html`, click/drag/edit everything visually (no code), run an automated quality "doctor", apply brand themes, and export pixel-perfect PDF. Original files are never modified without consent; export strips all editor artifacts.

Built by a solo developer (git author `SUN7485`) whose own Arabic university lectures are the proving ground. Started 2026-07-03 as a personal Electron tool; pivoted 2026-07-09 toward a sellable free-online web editor.

**Positioning (the product bible, `docs/resell-study.md`):** nobody wakes up wanting "an HTML slide editor." The real wedge is **"the fixer for AI-generated slides"** — millions of people get HTML decks out of ChatGPT/Claude/Gemini and have no tool to touch them (Canva and PowerPoint can't open them; code editors terrify them). Three stacked wedges:

1. **AI-output fixer** — new category, no incumbent, rides everyone else's AI wave with zero AI in the product.
2. **Arabic-first** («محرر الشرائح العربي») — bilingual shell, Arabic leads in marketing; no competitor owns this.
3. **Anti-cloud** — no signup, nothing uploaded, works offline, the deck IS the file. Canva/Gamma structurally cannot copy this.

## 2. The two surfaces, one engine

| | `src/` — Electron desktop | `web/` — static web app |
|---|---|---|
| Born | v1, 2026-07-03 | web pivot, 2026-07-09 |
| Role | Personal power tool; owns everything AI (Studio: wand, diagram lab, image lab), Brand-Kit modal, native PDF engine | **The sellable product.** Free online editor; deploy target Hostinger (deferred — see LOCAL-FIRST) |
| Stack | Electron 31, `main.js` + `preload.js` (secure IPC) + `renderer.js` | Pure static: `index.html` + vanilla JS, **no build step, no frameworks, no bundler** |
| Monetization | none (personal) | ads → watermark/Pro planned; pricing shape: Free / Pro one-time / School license (MENA culture prefers one-time over subscription) |

**Strategy decision (resell study §3): web is the product, Electron is the personal power tool.** Feature UIs no longer need cosmetic parity (the Electron doctor dock kept its light theme while web went dark — functional parity only).

### THE SYNC LAW (the one rule that bites)

`editor.js`, `theme.js`, `doctor.js` exist as **byte-identical twin pairs** in `src/` and `web/`. Edit one → copy to the other → `git diff --no-index src/X.js web/X.js` must print nothing. This has held through every feature. Any change to these three files in one shell MUST land in both.

## 3. Tech stack & scale

- Vanilla JS everywhere, ~13,700 lines total. No TypeScript, no React, no build tooling. Web ships as-is from disk.
- Key files (line counts 2026-07-17):
  - `editor.js` — 2,315 (×2, twin) — the engine: selection, drag/resize/snap, text editing, colors, tables, slides, undo/redo, theme-kit application (`applyThemeKit`), clean-HTML serialization (`getCleanHtml()`)
  - `doctor.js` — 887 (×2, twin) — deterministic lint engine + auto-fixers (`window.SlideDoctor`)
  - `web/app.js` — 1,300 — web shell: open/save-in-place/autosave/recents, toolbar, doctor dock (dark cards), theme UI, import, present, palette
  - `src/renderer.js` — 1,248 — Electron shell equivalent (light dock)
  - `src/main.js` — 348 — dialogs, PDF engine (`printToPDF`, slide-page sizing)
  - `src/brandkit.js` — 461 — customer brand kits: CSS-var detect+override, `@font-face` aliasing, Google-font embedding (`fetchGoogleFontFaces`/`fetchPresetFaces`), presets saved in `userData`
  - `src/enrich/` (pipeline 942, diagrams 422, charts 266, ai 234) + `src/studio/` (panel 589, imageCard 230, diagramEditor 195, wand 165) — Electron-only AI Studio
  - `present.js` 186 (×2), `importer.js` 122 (×2), `theme.js` 79 (×2), `settings.js` 107, `preload.js` 36
- Dependencies: `mathjax` (runtime), `electron` 31 + `electron-builder` + `playwright-core` (dev). `mammoth.js` vendored in `vendor/` for .docx import.
- Windows packaging: NSIS one-click installer (`Build Installer.bat`, output in `dist/`); `Start Lecture Editor.bat` for daily use.
- `config.json` (gitignored; `config.example.json` committed) holds the Gemini API key for the Electron Studio; in-app ⚙️ settings page writes it.
- Editing model: the lecture loads into a **same-origin iframe** sized to content; the editor manipulates that DOM directly. Cross-frame drags use pointer capture + `pointer-events:none` on the frame.

## 4. Doctrine — locked decisions (do not relitigate)

1. **Deterministic > AI.** Doctor rules, diagram engine, Arabic pack, palette math — all offline, rules/geometry/math only. "Smart without a model." AI exists only in the Electron Studio and is **proposal-first** (never generate before user approval — API quota is precious). Local LLM: evaluated and **rejected** (2026-07-11). The web product ships with **zero AI**.
2. **Fonts are always embedded as `data:` URLs**, never linked (offline + PDF safety). All theme/brand CSS rides one managed `<style id="ve-theme">` via `editor.applyThemeKit`; embedded font faces live in `ve-embedded-fonts`.
3. **UI language:** Arabic labels, Western digits, RTL-safe CSS (`margin-inline-start`, logical properties).
4. **MiM brand** (a ministry client; built-in preset): palette purple `#413258` / teal `#1AD9C7` / accent **pink `#BFA19F`** — the gold `#C5A059` seen in old decks is **off-brand**. Real fonts Lyon/Diodrum (local), official secondary face Cairo. MiM is just a preset of the general theme-kit system, to be anonymized as «وزاري» in the sellable product.
5. **LOCAL-FIRST (user decision 2026-07-15):** no Hostinger/deploy/domain spend until the product is proven great locally on real lectures with real users. Order: commit backlog ✓ → local hardening ✓ (save-in-place/autosave landed) → **prove on real lectures/users ← we are here** → only then deploy.
6. **Undo is sacred:** every mutation (including every doctor fix and fix-all pass) must be one undoable commit.
7. **Kill list** (explicitly never building): accounts/cloud sync, realtime collaboration, any AI in the web product, animation timelines, video export, native mobile editor, .pdf *import*, audience-sync backend.

## 5. Feature inventory (shipped + verified)

### Core editing (both shells)
Click-to-select anything (paragraphs → whole slides), ⬆ climb to parent container, delete, double-click text editing with B/I/U, undo/redo, Ctrl+S. Insert text/divider/table (inherits document styling), image drag-drop with landing-spot indicator + placeholder replacement, 8-handle resize, align, duplicate slide, cross-slide dragging, free-floating drag for any element, snap guides incl. equal-spacing (Figma-style distribution) guides, z-order. Colors: text/fill pickers whose palette is built from the lecture's own CSS theme colors.

### 🩺 Slide Doctor — **the moat** (v5, 2026-07-17, twin engine + per-shell docks)
Deterministic lint over the deck → **root-cause cards** (v4 `aggregate()`: e.g. 26 low-contrast instances collapse into ONE card; 92 raw rows → 3 honest cards), health score (100 − cards), count pills, clickable chips that focus the offending slide, deck-level chip «العرض كله», persistent dismiss, rescan.
**v5 = "fix all really fixes all": every rule is auto-fixable.** `fix()` may return a Promise; both docks await fixes; **fix-all loops passes until convergence** (cap 5, one undo step per pass, busy-guard). Verified one click: 8 cards / 52 issues → 0 cards / score 100, on a real deck, in both shells.
Rules & fixes include:
- **low-contrast** (WCAG < 3:1) → recolor **all** failing elements per slide (worst-only never converged), snapping to the deck's own palette (`_snapPalette` picked on-brand purple over "just darker" in verification)
- **broken-image** → delete (undoable) · **blurry-image** (natural vs displayed px) → shrink to true pixels
- **text-overload** → split slide at a balanced unit boundary (lists open into items; heading-dangle guard; advisory when unsplittable)
- **empty-slide / duplicate-slide** → delete
- **font-zoo** (intruder families) → set intruders to the slide's dominant family, **excluding intruders from the vote** (EVO-009: an 8-label SVG intruder once outvoted the 5 real elements → silent no-op loop)
- **fonts-not-embedded** (Rule 19, routes to 🔤) → inject `local()` Tahoma-fallback `@font-face` · **fonts-external** (Rule 19b: deck loads fonts from googleapis/typekit/…) → async fetch the CSS + woff2 once, embed as `data:` faces, strip the links/@imports; fails safe offline. Deliberate boundary: local-install fonts *with* a generic fallback are NOT flagged (they degrade gracefully; zero-false-positive doctrine)
- plus spacing/line-height and other layout rules (v3 added 7 rules in one batch)

### 🎨 Theme kits & 🔤 Typography kit (both shells)
`.theme.json` export/import; presets MiM/Slate/Warm (+ neutral presets); one-click apply recolors live and persists into saved HTML. Font library: pick web fonts per role (headings/body), fetched from Google Fonts css2 **and embedded as data: URLs at apply time** (arabic+latin subsets); uploaded kit fonts win dedupe ties; offline = colors-only with honest status text. Electron additionally has the full **Brand Kit modal** (detect deck vars → override, `@font-face` aliasing, kit persistence in userData).

### Arabic pack (mission 011)
Arabic⇄Western numeral toggle, typography presets, Hijri/ميلادي date helpers, fully RTL web UI.

### 📄 Import (010A/B)
.docx via vendored mammoth → `DeckImporter` → editable deck; heading-split heuristics; findings in `docs/import-findings.md`.

### 🎤 Present mode (014)
Fullscreen presenter + separate speaker view, real slide sizing.

### ⌨️ Speed layer (009)
Ctrl+K command palette, slide hotkeys, markdown shorthand on typing.

### 📑 Templates (013)
5 Arabic education decks + `templates.html` gallery/landing page; offline font stacks (dead Google @imports removed).

### 💾 Trust layer (019, verified live)
**Save-in-place** via File System Access API (keep handle → `createWritable` on Ctrl+S; download fallback), **autosave to IndexedDB** (~15s/blur snapshots) with crash-recovery prompt + live thumbnail, **recent-decks panel** with rendered thumbnails on the empty state.

### ⬇ PDF export
Slide decks auto-detected → each slide = exactly one full-bleed PDF page (no A4 slicing); waits for fonts/images; regular documents get A4 + margins. Test hooks: `LVE_OPEN=<file>` auto-open, `LVE_EXPORT_PATH=<file>` bypasses the save dialog.

### AI Studio (Electron only, parked since web pivot)
Studio v3 phases 1–3 shipped 2026-07-07: "The Flip" (docked panel, ghost previews), "The Wand" (✨ selection→visual, offline), "Diagram lab" (7-layout deterministic carousel + node chips + revise, zero API calls). Enrich pipeline (Gemini) is proposal-first with figure captions «شكل N» + references slide. Phases 4–6 (image lab, hardening, advisor) pending in `docs/studio-v3-plan.md`. Gemini **image** model blocked on quota.

## 6. State right now (2026-07-17)

- All committed, working tree clean except untracked `2.html` (a real 15-slide MiM-palette test deck used to verify v5; ends 18 slides / score 100 after fix-all).
- Doctor v5 + MiM-preset honesty pass just landed (5 commits, `b7895b2`..`07adb42`).
- MiM audit verdict: Electron preset delivers real Lyon/Diodrum at 100% coverage; web preset now embeds Cairo stand-ins under every deck family with honest status (was colors-only, read as a dead button).
- V4 plan (`docs/v4-plan.md`, missions 008–014) fully landed. Trust audit 2026-07-16 verified every headline web feature on a real 26-slide lecture: doctor ✓ fix-all (72→84) ✓ save/autosave/recents ✓ theme ✓ PDF ✓.
- **Next per plan:** prove v5 with a second real user (assumption test #1: put the build in 2–3 teacher Telegram/WhatsApp groups, watch 5 people open their own files — *before* building more features); consider footer-renumber fix (known issue below).

## 7. Known issues (open)

1. **Slide split leaves authored footer numbers stale** — decks hardcoding «شريحة N من M» keep old numbers after a text-overload split (footer is authored content). Candidate fix: detect that exact pattern in `.footer*` and renumber on commit — edits authored text, decide deliberately.
2. **Gemini image quota** blocks the Electron image lab (parked).
3. **Preset faces dedupe to one subset per weight** (accepted): `dedupeFonts` keys on family|weight|style without `unicode-range`, so one subset's woff2 serves all codepoints. Fine for Google Arabic families (include basic Latin); would clip for non-overlapping families.
4. **Deck-CSS specificity beats kit fonts** (accepted, by design): decks with aggressive selectors keep their fonts; popover live sample makes it visible.
5. Non-bugs worth knowing: doctor chip focus-scroll uses smooth scrolling that headless/in-app preview browsers don't animate (check the flash outline instead); Electron resolves relative images from the real file dir so `broken-image` may legitimately differ vs web on the same deck.

## 8. Product strategy digest (from `docs/resell-study.md` — read it in full if advising on product)

- **Personas (JTBD):** MENA teacher (deepest; design defaults for her — templates, handout PDFs, .pptx import, watermark removal) · AI-chat power user (needs SEO discovery) · trainer/preacher (brand + present mode) · schools B2B (site license, locked org theme, doctor rule profile). The fired competitor is **PowerPoint + WhatsApp'd PDFs + the photocopier workflow**, not Canva.
- **Top bets, ranked:** 1) save-in-place/autosave ✓done · 2) **self-playing saved decks + footer growth loop** (embed ~3KB viewer runtime; every WhatsApp-shared deck becomes a demo; footer links back to the editor opening that very file) · 3) onboarding messy-deck demo («جرّب عرضًا فوضويًا» → score 38 → fix-all → 92 animation) + PWA offline · 4) doctor v5+ (baseline mode à la ESLint, incremental re-lint via MutationObserver, **projector-survival check** ☀️, color-blindness matrix, pacing rule, consistency rules) · 5) handout layouts 2/4/6-per-page + print pre-flight gate · 6) multi-select/align/distribute/tidy · 7) palette math (one brand color → WCAG-guaranteed kit in HSL), logo→theme (median-cut), "steal this look" (.theme.json from any deck) · 8) .pptx import (biggest funnel, biggest risk — spike first) · 9) font subsetting (Arabic fonts 200–800KB; 10–20× smaller files feed the share loop) · 10) deck-shape sniffer (detect reveal.js/remark/ChatGPT-output/bare-headings conventions → normalize; cashes wedge #1).
- **Riskiest assumption:** "other people have this problem" — the developer is one datapoint. Cheapest test first; if it fails, reposition before building bets 4–10.
- **De-personalization before sale:** bilingual shell + doctor messages (ar/en), MiM → anonymous «وزاري» preset, pick an ownable product name (current name is a description).

## 9. Development workflow (how work gets done here)

- **Planning model (Claude) never executes big mechanical work.** It writes *mission prompts* via `/handoff` → saved to `.claude/handoffs/NNN.md` (**gitignored**, local-only — a fresh clone won't have them) → pasted into a cheap executor (Cline/Kilo free plans, or a cheaper Claude session) → `/qc` verifies by git diff + running the app → commit. 28 missions authored to date (001–028); everything through 019 + 022a/b landed; **020 (self-playing decks), 021 (onboarding+PWA), 023 (handout PDF), 024 (align/tidy/duplicate), 025 (palette magic), 026 (font-subsetting spike), 027 (deck-shape sniffer), 028 (pptx-import spike) are authored missions awaiting execution** — held back by LOCAL-FIRST until real-user proof.
- Project memory spine: `CONTEXT.md` (orientation, hard-capped 500 words) · `SESSION_LOG.md` (newest-first session bullets) · `KNOWN_ISSUES.md` (every unfixed bug + trigger). Hard lessons get banked as EVO entries in the user's cross-project rulesets.
- **One writer at a time**: never run two agents/sessions writing this repo concurrently (it burned a session once).
- Commit style: imperative subject lines, feature-scoped (see `git log`); `.claude/`, `.clinerules/`, `.kilocode/`, `config.json` gitignored.

## 10. Verification recipes (hard-won; use these, not hope)

- **"Boot check" is not verification.** Drive the real app and look at real DOM/screenshots before claiming done.
- **Electron:** run a node script requiring the repo's `playwright-core`: `_electron.launch({args:['.'], cwd, env:{LVE_OPEN:'<deck>'}})` → `waitForFunction(() => window.__editor)` → click UI (e.g. `#btn-doctor`) → `evaluate` dock DOM + `page.screenshot()`. Playwright screenshots work; MCP-browser screenshots are flaky here — prefer DOM reads.
- **Web:** serve `web/` statically and drive with the browser. Gotchas: the preview server process is reused and does **not** reload edited JS on `preview_start` — you must re-navigate or `window.SlideDoctor` stays stale; smooth-scroll doesn't animate in the embedded preview (assert the flash outline, not scrollTop).
- Real fixtures: `Chp1-Lec1-2.html` (26-slide real lecture) and `2.html` (15-slide MiM-palette deck) have both been used as verification decks; `test-fixtures/`, `samples/` exist.

## 11. Guidance for a reviewing AI

Locked — don't spend tokens relitigating: deterministic-over-AI, local-first (no deploy yet), no frameworks/build step, the SYNC LAW, Arabic-first, MiM accent = pink not gold, kill list (§4.7), proposal-first AI in Electron.

Where fresh eyes genuinely help:
1. Pressure-test the **resell strategy** — wedges, bet ordering, the "web is the product" call, pricing for MENA.
2. **Doctor rule ideas** that stay deterministic (the projector-survival / pacing / consistency family) and any false-positive risks in existing rules.
3. **Growth loop design** (self-playing decks, watermark-as-link) — bet 2 is the next big lever and hasn't shipped.
4. Architecture risks as the twins grow (2,315-line `editor.js` ×2 — when does the byte-identical twin discipline break down? Is there a better sharing mechanism that keeps the no-build-step law?).
5. `.pptx` import feasibility (JSZip + XML mapping) — the biggest funnel with the biggest fidelity risk; spike design welcome.
6. Anything that makes the **first 60 seconds** (onboarding, empty state, messy-deck demo) more convincing for a non-technical Arabic-speaking teacher.
