# GEOMETRY FACTORY v1

Placement scored against **authored** truth, at the **delivered package**.
First run 2026-08-21.

```
THE FIRST GEOMETRY INVARIANT
Correct content at the wrong anchor is a FAILURE.
```

## Why this exists, and why before tables

`«78»` on `Chp1-Lec1-3(New)` p17 extracted **verbatim** — every character right,
every text gate green — and was delivered **125pt** from where the page paints
it, because the writer centred it in a cell the source right-anchors. No text
metric could see that. Neither could whole-page ink IoU, which said the page was
fine because the ink was still on it.

So placement gets its own axis, it is authored rather than derived, and it
terminates at the `.pptx` rather than at the model — the model had `«78»` right.

A cell is a **rectangle** before it is a table. There are no tables here.

## What is authored, and what deliberately is not

The BOX and the ANCHOR are written down in `geometry-spec.js`, so "did it land
where it was put" has an answer nothing in this pipeline produced. The INK extent
is **not** authored — how wide a string paints is the font's business — so it is
never asserted, only measured where a delta needs it.

## Not IoU. Signed, per edge

Two boxes can overlap heavily and be anchored to opposite edges. Every delta is
signed and per-edge, so "right size, wrong place" and "right place, wrong size"
are different rows:

```
Δleft  Δright  Δtop  Δbottom  ΔcentreX  Δwidth  Δheight  rotationError
anchorError — the delta at the edge the item is ANCHORED to
```

`anchorError` is the number that matters. The anchored edge is the one the source
promised; the opposite edge is free to absorb shaping drift, and on this project
that drift is real and harmless (p50 1.78pt). The bar is **0.5 em, not a fixed
point count** — a 7pt line and a 22pt line do not share an idea of "close", and a
flat threshold across a scaled page has already cost this project 1455 false
findings once (`tiny-text`).

## First run — 18 of 23

```
family      pass   |anchorErr| p50   p90     max
anchor       5/5        0.00    0.02    0.02      <- the «78» shape, all 3 anchors
single       2/2        0.00    0.00    0.00
tight        2/2        0.02    0.02    0.02
adjacent     0/3      176.24  176.24  176.24   <- see below
sameword     2/2        0.02    0.02    0.02
mixed        1/1        0.01    0.01    0.01
long         2/2        0.01    0.01    0.01
size         2/2        0.02    0.02    0.02
edge         2/2        0.02    0.02    0.02
rotated      0/2       93.87   93.87   93.87   <- see below
TOTAL       18/23
```

**The headline is the `anchor` family: 5/5 at 0.02pt.** The exact shape that
failed by 125pt on a real deck — short text in a wide box, at each of the three
anchors — is now measured and correct after the table-cell fix. That is the first
time this project has had a number for it.

## BOTH failing families are v1's fault, not the converter's

Stated plainly, because a factory that misreports is worse than no factory.

**`adjacent` — the fixture is unanswerable as authored.** Three boxes on one row
at x 60 / 210 / 360, with no rules drawn between them. In the PDF that is one
baseline with wide gaps, and nothing in the file distinguishes "three cells" from
"one line". The converter merged two of them (`Valueالجودة`) and that is the only
thing it could have done. **The finding is real and it is about the SPEC: a
rectangle with no drawn boundary is not recoverable as a rectangle** — which is
precisely why the table axis comes next and must author ruling lines.

**`rotated` — the matcher, not the writer.** The model carries `rotation: -90`
with a correctly rotated bbox, and the writer converts a rotated line to the
unrotated box PowerPoint spins about its centre. That box's x/y therefore differ
from the authored ones by design, and v1's row-and-x matcher pairs the wrong
shape. A rotated item has to be matched by its centre, and its authored box
compared after the same transform. Also visible: the **-45** item produces no
rotated block at all — the extractor's rotation pass was built and measured on
-90 only (42 glyphs across 29 documents, every one of them -90), so arbitrary
angles are unproven rather than broken.

## v1's own limits, so nobody quotes it for more

- One page, one producer (Chromium). No PowerPoint route yet.
- Rotation matching is wrong (above) — treat the `rotated` row as unmeasured.
- `adjacent` needs drawn boundaries before it means anything.
- Height and baseline deltas are computed and reported but **not gated**: our
  boxes are ink-derived and the authored ones are line boxes, so Δheight is
  expected and has no threshold yet.
- Nothing here measures multiline, sub/superscript, or a second page size. They
  are in Sol's fixture list and not in v1.

## Run it

```
node experiments/factory/geometry-emit.js      # spec -> HTML -> Chromium -> PDF
node experiments/factory/geometry-score.js     # PDF -> model -> PPTX -> deltas
node experiments/factory/geometry-score.js .work/factory/geometry.pdf --verbose
```

Exits 1 on any miss. Adding a fixture is a line in `geometry-spec.js`.
