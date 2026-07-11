# V4 — "Smart without a model" (master plan)

*Written 2026-07-11. Covers the six ideas from the brainstorm: Word→deck import,
Slide Doctor, Arabic-first pack, theme files + template gallery, speed layer,
present mode. Executed via /handoff missions (008+) for the VS Code agent,
verified via /qc. Claude plans and verifies; the agent types.*

---

## 1. Strategy

> **One engine, two surfaces, zero required AI.**
> Everything below is deterministic: heuristics, rules, and templates that *feel*
> smart. The AI track (image lab, JSON hardening, BYOK/Ollama) stays parked —
> decoupled, not deleted. Local LLM: rejected 2026-07-11 (Arabic quality at small
> sizes, web bundle weight, splits the codebase).

**Positioning umbrella: Arabic-first.** Every phase ships its Arabic/RTL story.
No competitor (Canva, Gamma, Beautiful.ai) owns "محرر الشرائح العربي" — we do.

**Sync discipline:** `web/editor.js` stays byte-identical to `src/editor.js`
(`git diff --no-index` empty). Every new shared module follows the same rule
(e.g. `src/doctor.js` ↔ `web/doctor.js`). UI shells (`src/renderer.js`,
`web/app.js`) diverge freely.

## 2. Current state (2026-07-11)

- Branch `wip/brand-theme-v2-studio-web`, uncommitted: `src/editor.js`,
  `src/renderer.js`, `web/editor.js` (+99/−40) — Brand Theme v2 follow-up
  (handoffs 006/007 territory). **Needs /qc before anything else builds on it.**
- Stray `New Text Document.html` at repo root — delete or move to test fixtures.
- Handoffs 001–004 (Studio phases 4–6: image lab, hardening, quiz/notes,
  PDF preview) — status unreconciled; image lab blocked on Gemini quota anyway.
- Web MVP (handoff 005) built: open / edit / save / PDF-via-print. **Not deployed.**

## 3. Phases

### Phase 0 — Land & deploy (do first, small)
1. `/qc` the working-tree diff against handoffs 006/007; fix-mission if FAIL.
2. Commit, merge `wip/brand-theme-v2-studio-web` → `main`. Remove the stray
   root HTML file (keep a copy under `test-fixtures/` if it's a test lecture).
3. Reconcile handoffs 001–004: /qc what was run, mark the rest **parked**
   (image lab waits on quota; the old "advisor" phase is superseded by Phase 1).
4. **Deploy `web/` to Hostinger now** (static). MVP live before features pile up;
   every later web phase ends with a redeploy.

### Phase 1 — 🩺 Slide Doctor (deterministic lint engine) — Mission 008
Grammarly-for-slides. Replaces/absorbs the planned Studio "advisor".

- New shared module `src/doctor.js` (synced to `web/doctor.js`): pure functions
  `analyze(slideDoc) → issues[]`, each issue `{ruleId, slideIndex, el, severity,
  message(ar), fix()}`.
- **Launch rules (5):** text overload (word/char count per slide), low contrast
  (WCAG ratio text-vs-background), font zoo (>2 families), stretched/distorted
  image (aspect mismatch), figure missing «شكل N» caption.
- UI: badge count in toolbar → docked list, click = scroll to slide + highlight,
  one-click **إصلاح** where a safe auto-fix exists. Same UI pattern both surfaces.
- Out of scope: no AI calls, no rewriting user text, no layout "redesign" fixes.
- Verify: seeded bad deck triggers all 5 rules; each fix applies + undoes;
  zero issues on a clean deck; no console errors; runs <100 ms on a 30-slide deck.

### Phase 2 — ⚡ Speed layer — Mission 009 (small)
- Ctrl+K command palette (fuzzy over existing actions; Arabic + English labels).
- Markdown shorthand in text blocks: `# ` heading, `- ` bullet, `1. ` numbered.
- Hotkeys: duplicate slide, new slide, delete slide, next/prev.
- Both surfaces; palette actions registered from a single action table.

### Phase 3 — 📄 Word → deck import — Missions 010A (spike) / 010B
The blank-canvas killer for web; also a desktop File-menu item.

- **010A spike (cheap, do before committing to design):** vendor `mammoth.js`
  (local file — static site, no CDN), convert 3 *real* lecture .docx files in
  the browser, write findings to `docs/import-findings.md`: heading fidelity,
  images, lists, tables, RTL handling. *Riskiest assumption: teacher docs are
  messy.* Mapping design is finalized only after this.
- **010B implement:** drop/open `.docx` → mammoth → HTML → split to slides
  (H1/H2 = slide break; orphan-paragraph grouping; images → data URLs; cap
  content per slide, overflow spawns "(تابع)" slide) → load into editor as a
  normal deck. Slide Doctor runs on the result automatically (import + doctor
  is the "wow" demo).
- Out of scope v1: .pptx, .pdf import; perfect table rendering (tables land as
  images-of-last-resort or simple HTML tables, whichever the spike says).

### Phase 4 — 🕌 Arabic-first pack — Mission 011
- Numeral toggle ١٢٣/123 (per-deck setting, applied on render + export).
- Arabic typography presets in the brand kit (font pairs with sane line-heights,
  tested against diacritics clipping).
- Hijri/Gregorian date helper for title slides.
- RTL audit: diagram arrows/flows read right→left; snap guides, palette, doctor
  messages all correct under `dir="rtl"`.
- Web shell UI: Arabic translation + RTL layout toggle (default by browser lang).

### Phase 5 — 🎨 Theme files + template gallery — Missions 012 / 013
- **012 Theme files:** export/import brand kit as a small `.theme.json` (palette,
  fonts, logo data-URL). Both surfaces. Ship 3 built-in presets (MiM included).
- **013 Template gallery:** 5 Arabic education templates (lesson intro, exam
  review, semester plan, comparison lesson, quiz deck) as plain HTML files;
  web landing page `templates.html` with thumbnails → "new from template";
  each template gets its own SEO-titled page on Hostinger.
- Monetization hooks (thin, not a paywall build-out): free = watermark on
  export stays; gallery free (it's distribution); custom theme import = the
  natural future "pro" lever. Decide pricing later — out of scope here.

### Phase 6 — 🎤 Present mode — Mission 014
- Fullscreen present from both surfaces (Fullscreen API over the existing iframe;
  keyboard/clicker nav; black/white blank keys).
- Speaker view: notes (reuse handoff-003 notes format if landed; else plain
  `data-ve-notes`), timer, next-slide peek — popup window on desktop & web.
- Out of scope v1: live share links / QR audience sync (needs backend — backlog).

## 4. Sequence & sizing

| # | Mission | Surface | Size | Depends on |
|---|---------|---------|------|------------|
| 0 | Land WIP + deploy web | both | S | — |
| 1 | 008 Slide Doctor | both | M | 0 |
| 2 | 009 Speed layer | both | S | 0 |
| 3 | 010A Import spike | web | S | 0 |
| 4 | 010B Word→deck | both | M–L | 010A |
| 5 | 011 Arabic pack | both | M | 0 (best after 008 for doctor msgs) |
| 6 | 012 Theme files | both | S | 0 |
| 7 | 013 Template gallery | web | M | 012 |
| 8 | 014 Present mode | both | M | 0 |

Two tracks can run in parallel (agent executes one while the other is in /qc):
**Track A (smart):** 008 → 010A → 010B. **Track B (polish):** 009 → 012 → 013.
011 and 014 slot into whichever track frees up. Redeploy web after every
web-touching merge.

## 5. Rules of engagement (unchanged)

- Every mission goes out via `/handoff` (numbered file in `.claude/handoffs/`),
  comes back through `/qc` with the checklist from this plan + the mission file.
- Verification is *driven*, not assumed: playwright-core + `LVE_OPEN` +
  `window.__editor`, screenshot, real Arabic RTL fixture deck.
- No mission touches `src/enrich/` or `src/studio/` AI plumbing (parked track).
- Anything cut from a mission gets written down as parked, not silently dropped.

## 6. Parked / rejected

- **Local LLM (Gemma etc.)** — rejected 2026-07-11 (Arabic quality, bundle size).
- **BYOK / Ollama backend** — parked; revisit when AI track resumes.
- **Image lab (handoff 001)** — parked on Gemini image quota.
- **Live present share-links, accounts, .pptx import, pricing build-out** — backlog.
