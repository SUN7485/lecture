# The merge — PDF reconstruction inside the Lecture Visual Editor

**Date:** 2026-09-01
**What this is:** `D:\lectuer` (Electron editor) with the PDF engine from
`D:\pdf=ppt` vendored into it, so one app does: **open HTML or PDF → edit
visually → export PDF or PPTX.**

Both original repos are untouched. This directory is a copy.

## The four decisions this was built on

| Decision | Chosen |
|---|---|
| Host shell | **Electron (`D:\lectuer`)** — keeps the installer, Chromium `printToPDF`, AI Studio, Brand Kit, and the larger editor. MuPDF is WASM, so it drops in with no ABI/rebuild risk. |
| Licensing | **Proceed, flag, decide later.** See [LICENSING.md](LICENSING.md). Nothing may be distributed. |
| Duplicate engines | **Route by input type.** Nothing proven was deleted. |
| Scope | **Working vertical slice, verified.** |

## Architecture

The normalized slide model stays the source of truth. It is **not** replaced by
HTML — the model carries per-glyph provenance, colorspace-correct fills, bidi
runs and font-licence facts that HTML cannot hold, and those are what the
fidelity gates read.

```
   PDF ──► engine/src/model/normalize.js ──► normalized model
                                                   │
                                                   ▼
                                    engine/model-to-html.js
                                                   │
  HTML lecture ────────────────────────────────────┼──► the editor's iframe
  Word (.docx) ────────────────────────────────────┘         (srcdoc)
                                                   │
                                                   ▼
                                            edit · Doctor
                                                   │
                                    ┌──────────────┴──────────────┐
                                    ▼                             ▼
                          Chromium printToPDF            pptxFidelity.js
                                  (PDF)                      (PPTX)
```

A reconstructed PDF becomes the **same** deck HTML the editor already eats, so
selection, the Doctor, themes, and both export paths work on it without knowing
it came from a PDF.

## What was added

| File | Change |
|---|---|
| `engine/` | The pdf=ppt engine, vendored (`src/`, `web/`, `experiments/`). |
| `engine/package.json` | **New.** `{"type":"module"}` — scopes ESM to the engine so the Electron shell stays CommonJS. |
| `engine/model-to-html.js` | **New.** Model → editable deck HTML. The join between the two apps. |
| `src/main.js` | `pick-pdf` + `import-pdf` IPC; cached dynamic `import()` of the ESM engine. |
| `src/preload.js` | `pickPdf`, `importPdf`. |
| `src/index.html` | `#btn-import-pdf` toolbar button. |
| `src/renderer.js` | `importPdf()`, button wiring, command-palette entry. |
| `package.json` | engine deps; `engine/**/*` added to the electron-builder `files`. |
| `test/electron-pdf-import.test.js` | **New.** End-to-end: PDF in → editor → PDF out. |
| `test/electron-pdf-to-pptx.test.js` | **New.** PDF in → PPTX out. |
| `test/fixtures/lecture.pdf` | **New.** A real 21-page Arabic lecture. |
| `test/electron-home-screen.test.js` | **New.** The home screen's cards, layout and flow wiring. |
| `start-all.bat` | **New**, replaces `Start Lecture Editor.bat`. Checks Node, dependencies, the vendored engine and mupdf separately, so a failure names which one. |

## The home screen

The app now opens on a front door instead of an empty canvas. Every card is a
**job**, not a file type — it picks the right source, opens the editor, and
remembers which export the job was about so that button is nudged (aqua ring +
toast) once the deck is on screen.

| Card | `data-flow` | Opens | Then suggests |
|---|---|---|---|
| PDF → PowerPoint | `pdf-pptx` | PDF import | PPTX |
| HTML Editor | `html-edit` | HTML | — |
| HTML → PDF | `html-pdf` | HTML | PDF |
| PDF → cleaner PDF | `pdf-pdf` | PDF import | PDF |
| Word → slides | `word` | .docx | — |

The `data-flow` values in `src/index.html` and the `FLOWS` table in
`src/renderer.js` are one contract across two files, and nothing else would
notice them drifting — a card naming an unknown flow is a button that silently
does nothing. `electron-home-screen.test.js` asserts they match.

## Verified (measured, not assumed)

- **Engine runs inside Electron.** MuPDF WASM loads in ~780 ms; no rebuild.
- **Whole real corpus converts.** 9 lectures (`chp.4/done`), 20–27 pages each,
  **477–2089 ms**, every image inlined. Nothing errored.
- **Geometry is faithful.** Rendered run widths vs the widths the PDF recorded
  (`run.srcW`): **median ratio 0.99**, p90 1.004. Horizontal overflow 0.
- **End to end in the real app** (`electron-pdf-import.test.js`, PASS, 12.3 s):
  clicking the real toolbar button imports 21 slides / 831 objects / 392 text /
  2 images / **12,569 Arabic characters / 0 U+FFFD**, `dir="rtl"`, and
  `#btn-export` writes a genuine **225,907-byte `%PDF`**.
- **PPTX out of a PDF-imported deck** (`electron-pdf-to-pptx.test.js`, PASS, 56 s):
  **507,791 bytes, 21 slide parts, 19 media parts**, and slide 1 carries **19
  native text runs, 19 `rtl="1"` paragraphs, 422 Arabic characters** — genuinely
  editable PowerPoint content, not a picture of a slide. The full verification
  pipeline ran on it: 21 slides rendered in Chromium *and* real desktop
  PowerPoint and compared, `structural.ok: true`. The app's own status is
  honest about the rest — *"تم التصدير — 16 شريحة غير مطابقة… 8 عنصر مطبوخ"*
  (exported; 16 slides below the frozen SSIM bar, 8 elements baked by self-heal).
  SSIM min/median/max **0.718 / 0.809 / 0.896** against a threshold of 0.8487 —
  the pre-existing cross-renderer Arabic-density limit already recorded in
  KNOWN_ISSUES (real lectures land 0.72–0.85), **not** something the merge
  introduced, and deliberately not "fixed" by widening the number.
- **The Doctor works on imported PDFs for free** — it reported 7 findings on the
  test lecture without being told the deck came from a PDF.
- **Text survives the round trip: 99.53% word recall.** The corpus pairs every
  PDF with the authored HTML it was rendered from, which is a real oracle. Word
  recall of the reconstruction against that authored text, per lecture:

  | lecture | truth words | recall | Arabic truth → got | U+FFFD |
  |---|---:|---:|---|---:|
  | Chp4-Lec23-1 | 3522 | 0.9946 | 17274 → 17247 | 0 |
  | Chp4-Lec24-2 | 2748 | 0.9964 | 12449 → 12433 | 0 |
  | Chp4-Lec25-1 | 2729 | 0.9971 | 12573 → 12564 | 0 |
  | Chp4-Lec26-1 | 2839 | 0.9975 | 13460 → 13452 | 0 |
  | Chp4-Lec27-1 | 2707 | 0.9956 | 12190 → 12187 | 0 |
  | Chp4-Lec28-1 | 2727 | 0.9963 | 12064 → 12060 | 0 |
  | Chp4-Lec29-1 | 2919 | 0.9952 | 13080 → 13072 | 0 |
  | Chp4-Lec30-1 | 2724 | 0.9949 | 11996 → 11996 | 0 |
  | Chp4-Lec31-1 | 2834 | 0.9901 | 12577 → 12569 | 0 |
  | **total** | **25749** | **0.9953** | | **0** |

  Recall is order-independent (a word multiset), so bidi reordering is not
  charged twice; it measures whether the words arrived, not where they landed.

## The bug worth remembering

Every run's inline style was silently discarded, and the whole deck rendered at
the browser's default 16 px Segoe UI. Cause: the font stack used **double**
quotes inside a double-quoted `style="..."` attribute, so the attribute
terminated at the first font name — taking `font-size` and `color` with it.
It looked like a font-substitution problem and was a quoting problem. It was
found by measuring the *painted* value (281/281 runs in Segoe UI 16 px), never
by reading the code.

## Open — not done tonight

1. **PPTX for PDF-imported decks does not yet use the pdf=ppt exporter.** It
   currently goes through `pptxFidelity.js` like any HTML deck, so the
   corpus-locked writer and `refont.js` (the fix that made decks render on other
   people's machines) are **not** on this path. Doing it properly needs the model
   kept alive after import and an HTML→model round trip, or edits are lost.
2. **Import blocks the main process** (0.5–2.1 s on 20–27 pages; scales with page
   count). A 118-page lecture will visibly freeze the window. Needs a worker.
3. **Table cells can still clip** — 3/156 segments wide, 5/156 tall on the
   stress-test document. `white-space: pre-wrap` was tried and is worse: it
   breaks titles and causes line collisions.
4. **`pptxgenjs` is in `devDependencies`** but used at runtime. Pre-existing,
   not introduced here; a packaged build would break.
5. **`.cache` in `D:\lectuer` is a symlink** to `C:\Users\mosun\.cache` and was
   deliberately not copied.
