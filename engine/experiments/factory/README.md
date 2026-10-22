# SYNTHETIC GROUND-TRUTH FACTORY

Text whose truth is **authored**, not extracted. First run 2026-08-20.

## Why

Every accuracy number this project publishes describes 28 Chrome prints of one
HTML template, because that is the only corpus with a ground truth beside it.
`probe-producer-robustness.js` already makes a second producer out of parts here,
but its truth is model A — itself an extraction — so it can prove the extractor
is SELF-CONSISTENT across producers and cannot say whether it is RIGHT.

Here the string is written by hand in `spec.js` and every producer is asked to
reproduce it.

```
spec.js ──emit-html──> HTML ──Chromium──> PDF ─┐
        └──build─────> PPTX ──PowerPoint─> PDF ─┴─extract─> model ─compare─> spec
```

## Two routes, and the second one is the CONTROL

A score from one route cannot separate *"the extractor is wrong about this
construct"* from *"this producer's PDF is degraded"*. The PowerPoint route is
known to be degraded in one specific way — its PDF export drops
install-on-demand embedded fonts, so every glyph in it is named Calibri.
Chromium is the producer the corpus is made of, where delivered accuracy is
98.49%. Running both is what makes either readable.

## Where it stands (2026-08-20, after three defects were closed)

```
                    Chromium            PowerPoint
                    Skia/PDF m151       via SaveAs 32   [FLOOR — see below]
family        exact  recall        exact  recall
arabic         3/3   100.00%        1/3    94.97%
lamalef        4/4   100.00%        1/4    95.03%
marks          4/5    97.78%        0/5    90.92%
mixed          3/3   100.00%        1/3    83.28%
formula        4/4   100.00%        1/4    81.55%
citation       2/2   100.00%        1/2    75.00%
digits         2/2   100.00%        0/2    86.61%
separator      2/3    96.49%        0/3    83.92%
tamarbuta      2/3    96.30%        1/3    96.48%
tight          4/4   100.00%        4/4   100.00%
latin          2/2   100.00%        2/2   100.00%
TOTAL         32/35   99.06%       12/35   90.29%
```

**The PowerPoint column is a FLOOR and must be labelled as one wherever it is
quoted, until this route's font-export environment is CONTROLLED.** Its PDF
export drops install-on-demand embedded fonts, so every glyph in it is named
Calibri and an unknown share of its losses belong to the substitution rather than
to the extractor. Controlling it means one of: embedding fonts the export will
keep, using faces already installed system-wide, or measuring the substitution's
own contribution and subtracting it. Until then the column's value is the
per-family SHAPE — `citation` 1/2, `formula` 1/4 — never its total.

## What the factory has found so far

Three defects, each reproduced as an authored item before anything was changed.

**Arabic-Indic digits were reversed, in every document, always** (run one).
`الشريحة ١٠ من ١٩` came back `الشريحة ٠١ من ٩١` — ten delivered as one.
`classify()` tested `RE_RTL` before `RE_AN` and U+0660-0669 sit INSIDE the Arabic
block, so `RE_AN` was dead code for the whole block it existed for. Now `EVO-045`.

**An Arabic number reversed around its own separator.** U+066B and U+066C are
Bidi_Class AN; classed R they split one number into two AN islands and the whole
thing flipped — `٣٫١٤` back as `١٤٫٣`.

**A repair was inventing whitespace.** Scored `--raw`, the extractor gets tight
arithmetic 4 of 4 and never adds a space; `numeric-direction` rebuilt the
expression from a fixed template and turned `16=16+0` into `0 + 16 = 16`. Those
four blocks were the only text on the whole 118-page Unit Five deck rendering
more than one em past its own box; that class is now 0. **This also corrected a
diagnosis made from renders alone the day before** — the cause was named as the
extractor's space synthesis and it was not.

**Still open:** structured text TRUNCATES a line whose last word ends in a
mark-carrying base. The device path reports 18 glyphs on the baseline and stext
16; the missing `ﺓ` U+FE93 and `ً` U+064B sit left of stext's leftmost glyph. It
fails only at the LOGICAL end of a line — `مرةً` mid-sentence is exact — and
`charactersMissing` is null, so the existing detector is blind to it.

## Scope of v1, so nobody quotes it for more than it measures

TEXT ONLY. One item per line, one line per row, matched to its spec item by
BASELINE and never by text — a text-similarity matcher would assume the answer it
is checking and would hide the two failures that matter most, an empty block and
two items merged into one. **Tables, per-glyph geometry, font identity and
formula structure are not measured yet**; each needs its own emitter and each is
a real gap.

## Run it

```
node experiments/factory/build.js       # spec -> PPTX -> PowerPoint -> PDF
node experiments/factory/emit-html.js   # spec -> HTML -> Chromium  -> PDF
node experiments/factory/score.js .work/factory/chromium.pdf
node experiments/factory/score.js .work/factory/powerpoint.pdf --verbose
```

Adding a family is a line in `spec.js`. Adding a producer is a new emitter that
writes the same rows at the same pitch.
