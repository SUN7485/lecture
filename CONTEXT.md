# CONTEXT — what this project is (hard cap 500 words)
<!-- The permanent orientation file. Update on big decisions, never let it bloat. -->

## What
**Lecture Visual Editor (LVE)** — tool to visually enrich Arabic RTL HTML lectures and export PDF.
Two shells, one engine:
- `src/` — original **Electron desktop app** (v1 2026-07-03). Owns the AI Studio (wand, diagram lab, image lab) + Brand Kit modal + PDF export.
- `web/` — **free online HTML slide editor** (web pivot 2026-07-09). Static, no build step, vanilla JS. Deploy target: Hostinger. Monetization: ads → watermark/pro. AI decoupled (stays in Electron), not deleted.

## SYNC LAW (the one rule that bites)
`editor.js`, `theme.js`, `doctor.js` exist as **byte-identical pairs** in `src/` and `web/`.
Edit one → copy to the other → `git diff --no-index src/X.js web/X.js` must print nothing.

## Key decisions (do not relitigate)
- **Deterministic > AI**: doctor rules, diagram engine, Arabic pack are all offline/deterministic. Proposal-first for anything AI (quota!).
- **Fonts/brand**: kits ride one managed `<style id="ve-theme">` via `editor.applyThemeKit`; fonts always **embedded data: URLs**, never linked (offline + PDF safe). MiM is just a built-in preset (accent = pink `#BFA19F`, NOT gold).
- **UI language**: Arabic labels, Western digits, RTL-safe CSS (`margin-inline-start` …).
- Local LLM: rejected (2026-07-11).

## Workflow
Claude plans → `/handoff` writes mission (`.claude/handoffs/NNN.md`, gitignored) → **Cline/Kilo executes** → `/qc` verifies by diff → commit. Claude never executes outsourced work itself.

## Plans
- `docs/v4-plan.md` — V4 (missions 008–014: doctor, import, Arabic pack, templates, present) — **all landed**.
- `docs/studio-v3-plan.md` — Electron Studio phases 4–6 (image lab, hardening, advisor) — pending, parked since web pivot.

## WIP right now (2026-07-15)
- **Phase A (sellable product)** — strategy locked 2026-07-15: Arabic-first wedge, market ME → EU → world. `docs/resell-study.md` is the product bible. Order: commit backlog → deploy `web/` to Hostinger → name/domain/landing → 10 real users.
- **018 Doctor v4 "root causes, not rows"** — EXECUTED by Opus, verified live, committed 2026-07-15. Engine (`doctor.js` twin) gained deck-level reasoning + `aggregate()` (version 4): phantom-overflow killed (measures real content extent, not scrollHeight), font-zoo now deck-aware (design systems not flagged; only intruder families), text-overload deck-relative (median×1.5), new Rule 19 fonts-not-embedded (only fires on distinctive fonts with NO safe fallback). Web dock (`app.js`+`index.html`) redesigned: dark theme + one card per root cause (count pill, clickable slide chips, fix-all in one undo step), score counts cards not rows. Real 26-slide lecture: 92 issues/0 → 3 cards/72. Electron dock UI (`src/renderer.js`) still on old row list over the new engine — follow-up. Details + the Rule 19 design change: `.claude/handoffs/018-doctor-v4.md`.
- **016** doctor v3 (engine + dock UX) — committed `d2b108b`/`7703dfe`. Superseded by 018's dock redesign.
- **017** typography kit (font library, per-role fonts) — committed `13a8534`. The 🔤 button Rule 19 points users to.
