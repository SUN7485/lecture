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
- `docs/pptx-v2-plan.md` — "HTML = PPT" editable PPTX export (missions 032–038: first truth, total coverage, calibrated gate, self-heal, font embedding, proof screen, regression lock). **Phases 0–5 landed** on `wip/pptx-v2`; every export is now verified against a real PowerPoint render at thresholds derived from measurement, and the PPTX preview is the side-by-side proof screen.

## WIP right now (2026-07-17)
- **Phase A (sellable product)** — strategy locked 2026-07-15: Arabic-first wedge, market ME → EU → world. `docs/resell-study.md` is the product bible. **LOCAL-FIRST (user decision 2026-07-15): no Hostinger/deploy/domain spend until the product is proven great locally on real lectures.** Order: commit backlog ✓ → local hardening (save-in-place, autosave — study §2.1 "fix first") → prove on real lectures/users → only then deploy.
- **Doctor v5 "fix all really fixes all" (2026-07-17)** — every rule auto-fixable (broken-image delete, blurry shrink, slide split/delete, `local()` font fallback, async Google-fonts embed that removes the network dependency); `fix()` may return a Promise, both docks await + loop fix-all passes to convergence. Verified on 2.html: one click 8 cards/52 → 0/100 in both apps. Low-contrast fixes ALL failing elements per slide (worst-only never converged); font-zoo target excludes intruders (EVO-009).
- **MiM preset (2026-07-17)** — Electron = real Lyon/Diodrum (verified 100% coverage). Web now embeds **Cairo (official secondary)** under every deck family (`applyBrandTheme` carries `ext` per face) + honest status; previously colors-only, which read as a dead button on MiM-palette decks.
- **018 Doctor v4 "root causes, not rows"** — committed 2026-07-15; superseded by v5 fixers, card dock design unchanged. Details: `.claude/handoffs/018-doctor-v4.md`.
- **016** doctor v3 (engine + dock UX) — committed `d2b108b`/`7703dfe`. Superseded by 018's dock redesign.
- **017** typography kit (font library, per-role fonts) — committed `13a8534`. The 🔤 button Rule 19 points users to.
