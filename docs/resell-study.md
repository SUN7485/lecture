# Resell Study — from "my tool" to "their product"
*Product brainstorm, 2026-07-13. Scope: the web surface (`web/`) as the sellable product.
Constraint honored throughout: **zero AI** — deterministic heuristics, geometry, math,
and rules only ("smart without a model", same doctrine as v4).*

---

## 0. The one reframe (read this even if you skip the rest)

You are not selling "an HTML slide editor." Nobody wakes up wanting one.
The product already whispers its real identity in its own empty state:

> *"Got one from ChatGPT, Claude or Gemini? Edit the text, move and resize
> anything like PowerPoint."*

That's the wedge. **The fixer for AI-generated slides.** Millions of people now get
HTML decks/pages out of chatbots and have *no tool* to touch them — Canva can't open
them, PowerPoint can't open them, VS Code terrifies them. You own the empty niche
between "AI generated it" and "I need to present/print it." This positioning needs
zero AI in the product — it **rides everyone else's AI wave** without paying for it.

Three stacked wedges, in order of sharpness:

1. **The AI-output fixer** — open what ChatGPT made, fix it, present it. New category, no incumbent.
2. **Arabic-first** — «محرر الشرائح العربي». Already the plan; no competitor owns it. Arabic-first ≠ Arabic-only: ship bilingual shell, lead Arabic in marketing.
3. **The anti-cloud editor** — no signup, nothing uploaded, works offline, the deck IS the file. Sells itself to schools, ministries, and anyone with bad internet or privacy rules. Canva/Gamma structurally cannot copy this — their business model *is* the cloud.

Everything below serves those three wedges.

---

## 1. Who buys it (JTBD, not demographics)

| Persona | Job-to-be-done | What they'll pay for |
|---|---|---|
| **Teacher (MENA)** | "When I prep tomorrow's lesson, I want slides + printable handouts fast, so I look prepared without living in PowerPoint." | Templates, handout PDF, .pptx/.docx import, watermark removal |
| **AI-chat power user** | "When ChatGPT gives me an HTML deck, I want to fix and present it, so I don't rebuild it in PowerPoint." | Just needs to *find* you (SEO/growth loop); converts on polish features |
| **Trainer / preacher / lecturer** | "When I present weekly, I want my brand on everything with zero design skill." | Theme kits, palette generator, present mode |
| **School / training center (B2B)** | "When my staff make decks, I want them on-brand and decent-looking without a designer." | Site license, locked org theme, doctor rule profile |

The teacher persona is the deepest market *and* the one your own lectures already proved the product on. Design defaults for her.

Fired competitor (JTBD lens): they're not firing Canva — they're firing **PowerPoint + WhatsApp'd PDFs + the school photocopier workflow**. Beat that workflow, not Canva's feature list.

---

## 2. Feature-by-feature study

Format per feature: **Better** (product quality gap between personal tool and sellable product) · **Faster** (perceived + real speed) · **Smarter** (deterministic "smart-ass shit").

### 2.1 File open / save — *currently the weakest link, fix first*

Today: open via picker, save = download a new copy every time (`app.js:398`). Fine for you; product-killing for strangers — their Downloads folder fills with `deck(7).html` and one crash eats an hour of edits.

- **Better**
  - **Save-in-place** via File System Access API (`showOpenFilePicker` → keep the handle → `createWritable` on Ctrl+S). Fallback to download on Firefox/Safari. This single change moves the product from "toy" to "tool."
  - **Autosave + crash recovery**: snapshot the working doc to IndexedDB every ~15s / on blur; on next visit, "استعادة العرض غير المحفوظ؟" with a live thumbnail. The #1 trust feature for a tool holding someone's work. Non-negotiable before charging money.
  - **Recent decks** panel on the empty state: last N decks from IndexedDB with rendered thumbnails — the empty state stops being empty on visit two.
- **Faster** — reopening is instant (stored handle + permission re-request), no re-picking files.
- **Smarter** — **deck-shape sniffer** on open: detect the slide convention deterministically (your `.slide` format, reveal.js `<section>`, remark, bare `<h2>`-separated document, ChatGPT's typical single-page output...) and normalize into the editor's model. One detection table = "it just opens anything." This is the real enabler of wedge #1.

### 2.2 Canvas editing (select / move / resize / snap)

Today: single-select, drag, resize handles, snap guides, z-order, float. Solid core (2,313-line engine, battle-tested on real lectures).

- **Better** — the credibility set every PowerPoint refugee expects on day one:
  - Multi-select (shift-click + marquee), group/ungroup.
  - Arrow-key nudge (1px, Shift=10px), Alt-drag duplicate.
  - Align/distribute toolbar (left/center/right, equal spacing) — pure geometry.
  - Copy/paste elements across slides.
- **Faster** — during drag, move a GPU `transform` and commit to layout styles only on drop; cache `getBoundingClientRect` sweeps per drag session; batch guide redraws in one rAF. Target: 60fps drag on a 40-slide deck on a school laptop.
- **Smarter**
  - **Spacing guides à la Figma**: when dragging, detect equal gaps between siblings and show the red "equal spacing" hints — deterministic geometry, feels like magic, screams "real design tool."
  - **"تسوية" (Tidy) command**: one keystroke snaps everything that is *almost* aligned (≤4px off) to exact alignment, in one undo step. Nobody else has this offline. Pairs beautifully with the doctor.

### 2.3 Text editing

- **Better** — floating mini-toolbar on text selection (bold / size / color / highlight) instead of hunting the side palette; proper list editing (Tab/Shift-Tab indent).
- **Faster** — markdown shorthand already landed (009); advertise it in the palette.
- **Smarter**
  - **Fit-text-to-box**: binary-search the font-size until the text fits its container — the deterministic answer to overflowing titles, and the auto-fix for the doctor's overflow rule.
  - **Arabic typography autopilot** (extends the Arabic pack): normalize «» quotes, fix space-before-؟/!/،, harakat-safe line-height bumps when diacritics detected. A one-click "تشذيب النص" pass — rules, not models.

### 2.4 🩺 Slide Doctor — *the moat; invest disproportionately here*

v4 already does what no offline competitor does: deck-aware root-cause cards, 92-rows-of-noise → 3 honest cards. Grammarly-for-slides with no server. This is the feature reviews will screenshot.

- **Better**
  - **Baseline mode** (steal from ESLint): "accept the deck as-is; only flag *new* issues." Kills the last nag-factor for users importing old decks. Persist baseline hash per deck.
  - **Rule profiles**: مدرسة / جامعة / أعمال presets that tune thresholds (a quiz deck tolerates denser text than a keynote). Profiles are just JSON threshold sets — and the B2B lever later (org-locked profile).
  - Ship **bilingual rule messages** (ar/en) — Arabic-first, not Arabic-locked.
- **Faster** — **incremental re-lint**: MutationObserver marks dirty slides; rescan only those. Doctor becomes effectively real-time (lint-as-you-type badge updates) with near-zero cost. "Live doctor" demos far better than "click rescan."
- **Smarter** — new deterministic rules that make people *talk*:
  - **Projector-survival check** ☀️: simulate a washed-out cheap projector (lift blacks, drop saturation — a fixed color matrix), re-run contrast. "هذا النص سيختفي على البروجكتر" is a rule *no product on earth* ships, and every teacher has lived the pain.
  - **Color-blindness check**: same mechanism, deuteranopia matrix — flags color-only distinctions.
  - **Pacing rule**: reading-time per slide vs. slide count vs. a user-entered lesson duration → "الشريحة ٩ تحتاج ٣ دقائق وحدها."
  - **Consistency rules**: title y-position variance across slides, heading-size drift — deck-level geometry, extends the v4 `aggregate()` philosophy.
  - **Blurry-image rule**: natural resolution vs. displayed size ratio.
  - **Mixed-numerals rule**: ١٢٣ and 123 in one deck → auto-fix = the existing numeral toggle.
- **Productize the score**: "صحة العرض ٩٢" badge, before/after score animation on fix-all. The 40→95 moment *is* the marketing asset (see §4).

### 2.5 Arabic pack (numerals, dates, RTL)

- **Better** — numeral toggle becomes a **deck policy**, not a one-shot convert: setting persists in the deck (`data-ve-numerals`), enforced on every future edit/import/export. Same for the date helpers: insert as live fields (`data-ve-date="hijri"`) that re-render, not frozen text.
- **Smarter** — hamza/diacritic-normalized fuzzy search everywhere (palette, future find-in-deck): normalize أ/إ/آ→ا, ة→ه, strip harakat before matching. Tiny table, makes Arabic search feel supernatural. Also: punctuation-mirroring audit as a doctor rule.

### 2.6 🎨 Theme kits

- **Better** — live theme thumbnails rendered on *the user's own first slide* (not an abstract swatch); MiM demoted to just another preset with a neutral name; 6–8 presets tuned per persona (school, mosque, corporate, academic).
- **Smarter** — two genuinely magic deterministic tricks:
  - **Palette math**: user picks ONE brand color → derive a full kit in HSL space with WCAG-guaranteed contrast pairs (computed, not guessed). "One color in, professional theme out" — pure arithmetic, feels like AI.
  - **Logo → theme**: drop a logo, median-cut quantization on a canvas extracts dominant colors → feed the palette math. Median cut is 40 lines of deterministic code.
  - **"Steal this look"**: extract a `.theme.json` from any opened deck's computed styles (the var/font detection already exists in `editor.js`) — instant theme migration between decks.
- **Money** — custom theme import/export = the pro lever (already planned). Palette generator free (it's the demo), *saving* a custom kit = pro.

### 2.7 🔤 Font library

- **Better** — pair presets ("عنوان + متن" combos proven against diacritic clipping); previews use the user's actual deck title text.
- **Faster / smaller** — **font subsetting before embedding**: Arabic fonts are 200–800KB each; subset to used glyphs (vendored opentype.js/harfbuzzjs — deterministic) → 10–20x smaller saved files and PDFs. Directly serves the "deck is a WhatsApp-able file" story (§2.11): a 4MB deck kills that loop, a 400KB one feeds it.
- **Smarter** — **tofu detection**: canvas-measure suspicious glyphs against the fallback font; flag "this font lacks Arabic glyphs" *before* the user embeds it. Pairs with doctor Rule 19.

### 2.8 📄 Import

Today: .docx via mammoth, heading-split heuristics. Right idea; resell demands more mouths for the funnel.

- **Better**
  - **.pptx import** — the single biggest market unlock for teachers ("I have 10 years of PowerPoints"). JSZip + XML mapping, fully deterministic, no vendor lock. Big; spike it exactly like 010A before committing (riskiest sub-assumption: shape/position fidelity).
  - **Markdown import** — near-free to build, unlocks the entire dev/note-taker audience.
  - **Paste-from-Word/Docs** directly onto the canvas (clipboard HTML → same mammoth-ish cleanup path).
- **Smarter**
  - **Import report card**: after any import → auto-run doctor → "٢٤ شريحة، ٨ صور، الصحة ٦١ → إصلاح الكل؟" The planned "wow demo" — make it the *standard* post-import screen, not a demo.
  - Headingless-document splitter: paragraph-cluster + sentence-budget heuristics for wall-of-text docs (findings already in `docs/import-findings.md` — extend).

### 2.9 🎤 Present mode

- **Better** — spotlight/laser (mouse halo), transient ink annotations (gone on slide change), auto-hide cursor. All canvas overlays, all offline.
- **Smarter** — the deterministic feature deck-tools don't have:
  - **Pacing HUD**: user enters lesson length once → speaker view shows "الشريحة ٨/٢٠ — الدقيقة ١٢/٤٥ — متأخر بشريحتين," computed from slide count + doctor reading-time weights. Pure arithmetic; presenters will love it aloud.
  - **Rehearsal mode**: record per-slide dwell times locally → "الشريحة ٧ أخذت ٤٠٪ من وقتك." Feeds the pacing rule. No backend, no account.
- **Parked stays parked** — QR/audience sync needs a backend; the offline substitute is handout export (§2.10).

### 2.10 ⬇ PDF export

Today: print dialog. Works, but it's the money moment — polish it.

- **Better** — **handout layouts**: 2/4/6 slides per page + lines-for-notes variant, via print CSS. Teachers photocopy; this is a *paying* feature in the real workflow you're replacing. Add slide-range export.
- **Smarter** — **pre-flight gate**: before export, doctor runs the print-relevant subset ("٣ مشاكل ستظهر في الطباعة — إصلاح أولًا؟"). Contrast that fails on paper ≠ contrast that fails on screen — separate thresholds, still just math.
- **Money** — watermark on free export (planned) — but see §4: make the watermark a *link*, not a stain.

### 2.11 💾 The saved HTML file — *the sleeping growth engine*

Today the output is a static file. It should be the **distribution mechanism**:

- **Self-playing decks**: embed a ~3KB viewer runtime in every saved file — arrow keys/swipe navigate, `?present` starts fullscreen. The saved deck now *plays on any phone browser* with no app. In the WhatsApp-distribution culture of your target market, **every shared deck becomes a working demo of the product.**
- Footer on free tier: "صُنع بـ [product] — عدّل هذا العرض" linking to the editor which **opens the very file the person is holding**. Watermark-as-growth-loop, not watermark-as-punishment. This is the cheapest acquisition channel you will ever build, and it's ~S-sized.

### 2.12 ⌨️ Speed layer (palette, hotkeys)

- **Better** — palette shows hotkeys inline (it becomes the tutorial); frecency ordering (recently/frequently used actions first — a localStorage counter).
- **Smarter** — the §2.5 Arabic normalization applied to palette fuzzy-matching.

### 2.13 📑 Templates

- **Better** — grow 5 → ~15 with categories; every template = deck + theme + doctor profile bundled; per-template SEO landing pages (planned — this is the organic funnel, do it properly: real titles like "قالب مراجعة اختبار جاهز").
- **Smarter** — **"templatize my deck"**: strip text/images, keep layout boxes with placeholder labels → user turns their best deck into their personal template. Deterministic DOM surgery; also the seed of a future community gallery.

### 2.14 🚪 Onboarding / empty state

For you there was no onboarding; for strangers the first 60 seconds decide everything.

- **"جرّب عرضًا فوضويًا"** button: loads a deliberately messy sample deck → doctor shows score 38 → user clicks fix-all → 92, with the score animating. The entire value proposition demonstrated in 15 seconds, no signup, no file needed. Make this the hero interaction of the landing page too (screen-recorded, it's the ad).
- First-open coach marks (3 tooltips max: click text to edit · drag to move · 🩺).
- PWA manifest + service worker → installable, fully offline. One S-sized mission that *cashes the entire anti-cloud positioning* ("يعمل بدون إنترنت" on the landing page, and it's literally true).

---

## 3. Cross-cutting: what resell demands beyond features

- **De-personalization audit**: bilingual shell (ar default, en toggle); doctor messages ar+en; MiM becomes an anonymous "وزاري" preset; product name ≠ "Slide HTML Editor" (that's a description, not a brand — pick something ownable, ideally pronounceable in Arabic).
- **Pricing shape for MENA**: one-time purchase or cheap yearly beats monthly subscription culturally. Suggested: **Free** = full editor + doctor + templates + watermark/footer · **Pro (one-time)** = no watermark, theme import/save, handouts, font subsetting · **School license** = Pro × seats + locked org theme + doctor profile. Keep it this thin; pricing build-out stays backlog.
- **Sync law under productization**: the twin-file discipline (`editor.js`/`doctor.js`/`theme.js`) has held, but every resell feature above lands in *both* surfaces or explicitly web-only. Decide now: **web is the product, Electron is your personal power tool** — stop porting UI shells (the doctor-dock divergence already proved the cost).
- **Trust page**: privacy statement ("لا شيء يُرفع"), offline proof, no-account proof. For schools this page *is* the sales pitch.

---

## 4. Kill list (explicitly not building)

Accounts & cloud sync · realtime collaboration · any AI (BYOK stays parked in Electron) · animation timelines · video export · native mobile editor · .pdf *import* · audience-sync backend. Each one either breaks the anti-cloud wedge, the no-AI doctrine, or the one-developer budget.

---

## 5. Converge — top bets, ranked

| # | Bet | Wedge it serves | Size | Why this order |
|---|-----|----------------|------|----------------|
| 1 | Save-in-place + autosave/recovery + recents | trust (all) | S–M | Table stakes; nothing else matters if the tool eats work |
| 2 | Self-playing saved decks + footer link loop | growth | S–M | The acquisition engine; compounds from day one |
| 3 | Onboarding messy-deck demo + PWA offline | conversion, anti-cloud | S | Turns landing traffic into activated users |
| 4 | Doctor v5: baseline, incremental/live, projector + pacing + consistency rules | moat | M | The screenshot feature; deepen before anyone copies |
| 5 | Handout PDF layouts + pre-flight gate | teacher money | S–M | Directly monetizable, replaces the photocopier workflow |
| 6 | Multi-select / align / distribute / tidy | credibility | M | The PowerPoint-refugee expectation set |
| 7 | Palette math + logo→theme + steal-this-look | wow, pro lever | M | Demo-magic per engineering hour is unmatched |
| 8 | .pptx import (spike first, like 010A) | market unlock | L | Biggest funnel, biggest risk — spike before commit |
| 9 | Font subsetting | perf, file-size | M | Multiplies bet #2 (small files travel) |
| 10 | Deck-shape sniffer (open anything) | AI-fixer wedge | M | Cashes wedge #1 fully |

Track shape mirrors v4: **Track A (trust/growth)** 1→2→3 · **Track B (moat/money)** 4→5→7. Bet 8 spikes whenever an agent is free.

---

## 6. Riskiest assumptions & the cheapest tests

1. **"Other people have this problem"** — you are one datapoint. Cheapest test: put the current build in 2–3 teacher Telegram/WhatsApp groups, watch 5 people open their own file. *Before* building bets 4–10.
2. **"They'll pay"** — test with a fake-door: a "Pro" button that shows price + "coming soon" + email field. Conversion on intent, zero build.
3. **"The share loop works"** — instrument nothing; just count landing-page hits with `?from=deck` after bet 2 ships.
4. **".pptx fidelity is achievable"** — 010A-style spike on 3 real teacher .pptx files; findings doc before any design.
5. **"AI-chatbot users can be reached"** — one SEO page targeting "edit ChatGPT HTML presentation" (en + ar) and watch if it ranks; the niche has zero competition, so a single page is a fair test.

If #1 fails, stop and reposition before spending on anything below bet 3.

---

## 7. Next actions

- This study → missions: bets 1–3 are ready to become `/handoff` 019–021 (each is agent-sized and independent).
- Bet 4 (doctor v5) should wait until 018 is committed and the Electron dock question is settled (web-is-the-product decision, §3).
- Assumption test #1 costs zero engineering — it can start today with the current uncommitted build.
