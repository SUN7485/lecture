# CONVERGENCE BENCHMARK v1

## Current measured result (2026-08-21)

`.work/benchmark-editable-page-scores.json` is the first complete per-page
artifact: **83.66% editable visual, 410 damage regions, 1 off-slide, 294/294
pages converted, no deck regression**. It records `editableQuality` separately
from `productQuality`, so optional full-page fidelity images cannot inflate the
core score.

Calibrate with:

```
node experiments/benchmark/calibrate-delivery.js .work/benchmark-editable-page-scores.json
```

The measured counts below each candidate cutoff are 41 at 0.70, 51 at 0.75, 81
at 0.80 and 125 at 0.85. Because editable is the user-selected default and a
0.80 cutoff would replace more than a quarter of the corpus, optional Smart mode
uses the existing 0.70 visible-damage boundary.

**How far from done, in one number and one ranked list.**

## The problem it solves

This project had an instrument for everything and no finish line. Every session
found a real defect class and closed it — the corpus was one producer, so a
producer matrix was built; text metrics were blind to placement, so a geometry
factory was built; extraction accuracy had no truth, so a synthetic factory was
built. All of it was right, and none of it could answer *"is the product closer
to done than last week"*, because nothing ran the **whole** thing end to end on
documents a user would actually convert. So every session ended feeling identical
to the last.

```
frozen PDFs ──> src/cli.js convert ──> .pptx ──> PowerPoint render
                                                       │
                          source page render <── compared
```

The app is **spawned, not reimplemented** — `node src/cli.js convert` — so the
thing being measured is the thing that ships.

## The contract

- **The corpus is frozen.** `corpus.json` pins ten documents by path *and*
  content hash. Every number in `baseline.json` describes exactly those bytes.
  Changing the set is a deliberate act that invalidates the comparison.
- **One score, one list.** `VISUAL` is the page-weighted mean ink IoU of the
  PowerPoint render against the source page, with each page's own fit applied.
  `TOP REMAINING DAMAGE` ranks classes by affected regions and pages.
- **Every change produces a before/after.** `--diff before.json after.json`.

## What counts as damage — and what deliberately does not

Only what a reader would **see** or a downstream tool would **mis-read**.

`TEXTBOX_WIDTH` is excluded, and it is the design decision that makes the list
usable. It fires 2664 times on one deck, p50 1.78pt, and every case inspected was
a shaping difference of about a third of a character — text that neither wraps
nor clips because wrap and autofit are off. A signal that fires 2664 times cannot
rank anything, and a list it dominates hides the eight things that matter.

It is **not deleted**, and that is deliberate too: chasing four of its outliers
is what found a real numeric-reconstruction bug that had been inventing
whitespace in every document. So:

```
DIAGNOSTIC SIGNAL   !=   FAILURE GATE
```

A metric that is mostly false positives can still be the only thing that smells a
defect in another class. It keeps its home in `experiments/delivery/classify.js`,
where someone goes looking. It does not get a seat in the ranking.

Two thresholds exist for the same reason:

- **`OBJECT_OVERLAP`** requires the overlap to exceed a third of an em **in both
  axes**. Two correctly adjacent neighbours touch by shaping drift, and counting
  that produced 50 "overlaps" on a deck where the fix had just made the text more
  faithful, not less.
- **`VISUAL_LOW`** flags a page under 0.70 ink IoU. That is not a defect class —
  it is *"something is wrong here that nothing else named"*, and it is where to
  look when the ranked list runs out.

## The corpus

Ten producers, 294 pages, chosen so that no single generator's habits can
dominate the score.

| id | producer | pages | why it is in |
|---|---|---|---|
| `chrome-lecture` | Skia/PDF m126 | 20 | the corpus generator, and one of the only inputs with HTML ground truth |
| `chrome-lecture-2` | Skia/PDF m126 | 21 | tables, charts, worked examples |
| `ilovepdf-unit5` | iLovePDF | 118 | **three** physical page sizes, 31 tables — the document every reported defect came from |
| `indesign-brandguide` | Adobe PDF Library 16 | 40 | A4 landscape, clipped pictures, 9619 images |
| `powerpoint-2013` | Microsoft PowerPoint 2013 | 41 | a deck exported by the destination application itself |
| `distiller-mac` | Acrobat Distiller 5.0.5 | 15 | drop shadows: every heading painted twice |
| `acrobat-pdfmaker` | Adobe PDF Library 21 | 16 | Word via PDFMaker |
| `word-arabic` | Word for Microsoft 365 | 3 | Arabic from Word, majority DeviceGray |
| `camscanner-scan` | intsig.com | 4 | image-only — no text semantics exist in the file |
| `chrome-report` | Skia/PDF m149 | 16 | A4 portrait business report, a newer Skia |

Two of those are known to be **class B/C** inputs (outlined or scanned text).
They are in on purpose: a converter that silently degrades on them should show it
here rather than in a user's hands.

## How it is meant to be used

1. Run it. Keep `baseline.json`.
2. Fix **only the top damage class**.
3. Run it again into another file and `--diff` the two.
4. Repeat.

If the score keeps climbing, the architecture is fine and should be left alone.
**If it plateaus while meaningful defects remain, that measured plateau — not an
argument about APIs — is the trigger** to pull something from the PDF-compiler
research ceiling (representation tournament, PowerPoint-native compiler, source
scene IR, minimal fallback regions). The research document is a capability index;
this benchmark is what decides when to open it.

## Run it

```
node experiments/benchmark/run.js                        # score, write baseline.json
node experiments/benchmark/run.js --out after.json
node experiments/benchmark/run.js --diff experiments/benchmark/baseline.json after.json
node experiments/benchmark/run.js --only ilovepdf-unit5  # one deck, while iterating
```

Needs PowerPoint. Takes minutes, not seconds — it renders 294 slides.
