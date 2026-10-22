# RUN-LEVEL DIRECTION — priced, and REFUSED

**Verdict: do not ship run-level direction. The current writer already wins.**
Measured 2026-08-20 against PowerPoint build **20228**. Re-run to re-price it on
another build; do not re-argue it from the API documentation.

## The question

`paragraphDirection` is answered (`src/model/direction.js`). `runDirection` is a
named hole. DrawingML really does define `a:rtl` as a child of
CT_TextCharacterProperties (ECMA-376 §21.1.2.2.8, parents `rPr` / `defRPr` /
`endParaRPr`), and PowerPoint really does expose `TextRange.RtlRun()` /
`LtrRun()` for mixed-direction text — so the capability exists. The question was
never whether it exists; it was whether declaring it **changes anything a user
would experience**.

## Six mixed-direction fixtures, three builds

`fixture.js` builds them through the REAL writer, so A is production output:

```
PURE_ARABIC      الحل البياني للبرمجة الخطية
FORMULA_ONLY     =SQRT(2*D*S/H)
ARABIC_FORMULA   زمن الطلب: Ttakt = 25200 ÷ 900 = 28 ثانية
CITATION         [4] Shingo, S. (1985). منهجية تقليص زمن.
EMOJI_MATH       1000 × √4 ≤ 40
LATIN_ISLAND     تحسين بيئة العمل (Ergonomics) في المصنع
```

```
A  paragraph rtl only, as shipped today          fixture.js
B  A + explicit <a:rtl val="0|1"/> per run       build-b.js
C  A + COM RtlRun()/LtrRun() per run             apply-com-runs.ps1
```

## What each package contains

```
file                       paras  pPr rtl=1  runs  a:rtl=1  a:rtl=0  rPr@rtl
A-paragraph-only               6         3    12        0        0        0
A2-saveas   (CONTROL)          6         3    12        0        0        0
B-run-rtl                      6         3    12        6        6        0
B2-saveas                      6         3    12        0        6        0
B3-saveas-twice                6         3    12        0        6        0
C-com-runs                     6         3    15        0        0        0
C2-saveas                      6         3    15        0        0        0
```

**`RtlRun`/`LtrRun` write no run-level direction at all.** Zero `a:rtl`, zero
`rtl` attribute on `rPr`, on a build where all 12 calls returned without error.

**What they DO write is churn.** C's runs go 12 -> 15 (`Ttakt ` / `= 25200 ÷ 900 `
/ `= 28`) and every Arabic run's `lang` is rewritten `ar-SA` -> `ar-EG`, this
machine's Arabic proofing locale. `lang` is not decoration here — the writer sets
it deliberately because it drives PowerPoint's script detection. The fragments
re-merge to 3 runs in the object model on reopen, so the split is cosmetic; the
language rewrite is not.

**The control is what makes that attributable.** `A2` is A opened and saved with
no direction calls at all: 12 runs, `lang` untouched, byte-equivalent paragraphs.
So the churn in C belongs to `RtlRun`, not to saving. Without the control it
would have been filed under "PowerPoint rewrites things on save", which is the
answer everyone expects and is wrong here.

**PowerPoint canonicalises `a:rtl` asymmetrically.** `val="1"` inside an RTL
paragraph is dropped as redundant; `val="0"` — the one that contradicts the
paragraph — survives, and survives a SECOND round trip unchanged (B3). So the
half of B that says something is durable. It just does not do anything.

## What it changes for a user: nothing measurable

```
RENDER      PowerPoint at 1600px, A vs B vs C:  pixel-identical, all three
TEXT        logical text per paragraph:          identical, all three
RUN EXTENTS BoundLeft/BoundWidth per run,
            all six fixtures:                    identical, all three
INSERTION   marker inserted at the run-1 boundary of every mixed paragraph,
            then measured — identical logical index AND identical rendered
            position across all three, for both markers
```

The insertion probe uses **two** markers on purpose, and the pair is the proof
that the instrument can see direction at all:

```
ARABIC_FORMULA   'X' (strong LTR) lands at left 380.88
                 '-' (neutral)    lands at left 580.87
LATIN_ISLAND     'X' 412.38   ·   '-' 523.00
```

A neutral and a strong letter typed at the same boundary land **200pt apart**,
which is exactly the bidi behaviour run direction would govern — and A, B and C
put them in the same two places. A probe that reported "no difference" without
that spread would be evidence of nothing.

## NOT measured here, and it needs a human

Caret movement, Home/End, arrow keys across a direction boundary, and mouse
selection need real keystrokes in an interactive window. SendKeys automation is
not evidence. The fixtures are on disk — open `A-paragraph-only.pptx` and
`B-run-rtl.pptx` side by side and spend two minutes in the mixed paragraphs. If
they differ, this verdict is wrong and the evidence to overturn it is one
screenshot.

## Reproduce

```
node experiments/rtl-runs/fixture.js
node experiments/rtl-runs/build-b.js
powershell -File experiments/rtl-runs/apply-com-runs.ps1 <A.pptx> <C.pptx> <log.json>
powershell -File experiments/rtl-runs/saveas.ps1        <in.pptx> <out.pptx> <log.json>
powershell -File experiments/rtl-runs/editing-probe.ps1 <in.pptx> <out.json>
node experiments/rtl-runs/measure.js
```
