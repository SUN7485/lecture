/**
 * The doctor — rules that check a deck and, where it is safe, fix it.
 *
 * Pure functions over the normalized model, so the browser and the CLI run the
 * SAME code and cannot disagree about whether a deck is clean.
 *
 * THE FIX RULE. A rule may only carry a `fix` when the correct result is
 * derivable. Three findings are deliberately un-fixable because any automatic
 * repair would be a guess at the source's content, and inventing content is
 * worse than reporting uncertainty: suspect-dropped-alef, font-substituted and
 * duplicate-slide. Those are surfaced for a human decision instead.
 */

const ARABIC = /[؀-ۿ]/;
/**
 * A relation between two numbers — the signature of an arithmetic expression,
 * which is laid out left-to-right whatever language surrounds it.
 *
 * Kept in step with ARITHMETIC in src/extract/glyphs.js, which decides base
 * direction. Duplicated rather than imported because this module is loaded
 * directly by the browser as well as the CLI. If the two ever disagree, the
 * doctor will report a defect the extractor deliberately created.
 */
// The direction decision, imported rather than copied. The server serves this
// one module to the browser for exactly this reason: three copies of "is this
// line RTL" already exist in this project and the day they disagree the doctor
// reports an error about output the extractor produced on purpose.
import { textIsRtl } from "../src/extract/bidi.js";

const ARITHMETIC = /[\d)]\s*[=×÷+−≤≥<>]\s*[\d(]/;
/**
 * Arabic LETTERS, excluding combining marks.
 *
 * `ARABIC` above matches anything in the Arabic block, including a bare tanween.
 * Measured: "Modeً", "μ ± σً" and "μ+2σً" are Latin and Greek symbols carrying a
 * stray diacritic left by the known tanween/alef defect, and matching those as
 * "an Arabic paragraph" made the direction rule report an error on two decks.
 */
/**
 * Rules `convert` applies before writing, and the ONLY ones on by default.
 *
 * The bar is a corpus-wide measurement with zero regressions, because a
 * converter that quietly rewrites text on a guess is worse than one that reports
 * the defect:
 *
 *   bidi-damaged-call     9 hits corpus-wide, 9 genuinely broken, 0 false
 *                         positives; matches only a run that is entirely ")(N=".
 *   tanween-missing-alef  113 flagged at 100% precision, of which the repair
 *                         corrects 73 and breaks 0.
 *   lam-alef-reversed     44 sites, 20 fixed, 0 broken.
 *   numeric-direction     13 fixed, 0 broken — a number and its operator the
 *                         wrong way round (`%90`, `× 4 4`, `10%–5`).
 *   shadda-on-alef        7 fixed, 0 broken — a gemination mark on a long vowel,
 *                         which Arabic does not write.
 *
 * Every one of those numbers is measured through THIS path — per run, over a
 * model, after the other repairs — by `experiments/verify-repair.js`, never from
 * the probe that discovered the rule. The two disagree: the tanween probe said
 * 91 and the real path gives 73.
 *
 * It lives here so `cli.js`, `verify-pptx.js` and anything else that needs to
 * know what `convert` did all read the same list. A verifier that rebuilds a
 * reference model WITHOUT these reports the repaired paragraphs as missing and
 * fails a deck that is correct — that has already happened once, to Chp1-Lec4-2.
 */
export const DEFAULT_REPAIRS = ["bidi-damaged-call", "tanween-missing-alef", "lam-alef-reversed", "numeric-direction", "shadda-on-alef"];

const ARABIC_LETTER = /[ء-غف-يٮ-ۓۮ-ۿ]/;
const ARABIC_DIGIT = /[٠-٩]/;
const WESTERN_DIGIT = /[0-9]/;

/**
 * A spreadsheet call whose brackets and '=' ended up at the wrong ends:
 * ")(STDEV.P=" for "=STDEV.P()". Anchored at both ends so it can only match a
 * run that is ENTIRELY this shape — 9 hits corpus-wide, all genuinely damaged.
 */
export const DAMAGED_CALL = /^\)\(\s*([A-Za-z][\w.]*)\s*=$/;
export const repairCall = (s) => s.replace(DAMAGED_CALL, (_, name) => `=${name}()`);

/**
 * Characters that mean the text was corrupted on its way here: Arabic
 * presentation forms (shaped glyphs that must never survive extraction),
 * U+FFFD, and the classic UTF-8-as-codepage mojibake pair. FE00-FE0F is
 * deliberately excluded — that is the variation-selector block, and every "⚠️"
 * in the corpus is a correct U+26A0 U+FE0F.
 */
export const BROKEN_CHARS = /[ﭐ-﷿ﹰ-﻿�]|â€|Ã[-¿]/;
export const BROKEN_CHARS_G = /[ﭐ-﷿ﹰ-﻿�]|â€|Ã[-¿]/g;

/**
 * A fathatan whose alef went missing.
 *
 * The indefinite accusative is written on a final alef, and the two orderings
 * `مختلفاً` (alef then mark) and `قممًا` (mark then alef) are both ordinary, so
 * an alef on EITHER side clears it. ة, ء and the hamza-carrying alefs carry
 * fathatan legitimately and count as an alef. Measured 113 flagged / 113
 * genuinely wrong over 10206 blocks; the one-sided version of this test scored
 * 114/113 and its single false positive was `قممًا`.
 */
export const STRANDED_FATHATAN = /[^اةءآأإ]ً(?![اةءآأإ])/u;

/**
 * The definite article with its lam-alef ligature the wrong way round.
 *
 * `اإلجراء` for `الإجراء`, `األداء` for `الأداء`, `االختناق` for `الاختناق`. A
 * lam-alef is ONE painted glyph standing for two characters whose logical order
 * is always lam first; when the two halves are emitted alef-first and the
 * grouping pass fails to bind them, the reversal moves them independently.
 *
 * The three-character context is the whole safety of it. A bare `أل` is an
 * ordinary word fragment — `ألف`, `ألم` — and swapping every one of those was
 * measured at **996 sites, 20 fixed, 878 BROKEN**, turning `التمهيد` into
 * `لاتمهيد`. But an alef FOLLOWED BY another alef form is not something Arabic
 * writes at all, so `ا[اآأإ]ل` can only be the article plus a reversed ligature.
 *
 * Measured over all 28 decks (`experiments/probe-lamalef-swap.js`):
 *
 *   swap every hamzated alef+lam on sight        996 touched   20 fixed  878 broken
 *   only when a ligature is unaccounted for       54 touched   16 fixed    4 broken
 *   the article context, hamzated alefs           37 touched   14 fixed    0 broken
 *   the article context, all four alef forms      44 touched   20 fixed    0 broken
 *
 * Device evidence was tried as a gate and is REDUNDANT here — the hamzated rule
 * scores 14/0 with it and 14/0 without. The context already settles it.
 */
export const REVERSED_ARTICLE = /ا([اآأإ])ل/u;
const REVERSED_ARTICLE_G = /ا([اآأإ])ل/gu;

/**
 * A numeric expression whose parts came out in RTL order.
 *
 * Arabic writes numbers and their operators left-to-right exactly as English
 * does — `90%`, `4 × 4`, `5–10%` — but every one of those characters is either a
 * digit or a NEUTRAL, and a run of neutrals inside an RTL paragraph takes the
 * paragraph's direction. So the sign drifts to the wrong end of its number and
 * the ends of a range trade places. Nothing is lost; the reading order is wrong.
 *
 * Three shapes, each measured separately over all 28 decks
 * (`experiments/probe-text-rule.js`, on delivered blocks):
 *
 *   %90    -> 90%          7 touched, 2 fixed, 0 broken
 *   × 4 4  -> 4 × 4       10 touched, 4 fixed, 0 broken
 *   10%–5  -> 5–10%        6 touched, 6 fixed, 0 broken
 *
 * Every one is anchored on DIGITS on both sides of the operator, which is what
 * keeps it off ordinary prose. The same session measured two rules without that
 * anchor — a lam-alef swap in a new context (19 fixed, 249 broken) and joining
 * words split around a combining mark (25 fixed, 1155 broken) — and neither is
 * here. A rewrite of Arabic TEXT needs an impossibility behind it; a rewrite of a
 * numeric expression only needs both operands to be numbers.
 *
 * DO NOT widen these to the bare `–` range without a percent sign. `3–140` and
 * `195-2` are page and ISBN fragments in the bibliography lines, they are already
 * in source order, and flipping them corrupts correct blocks.
 */
/**
 * A shadda sitting on a bare alef.
 *
 * Shadda marks a doubled CONSONANT. Alef here is a long vowel and is never
 * doubled, so `اّ` is not a sequence Arabic writes — the mark belongs to the
 * letter before the alef and was sorted past it, giving `مبرَّراً` shapes with the
 * gemination on the wrong character.
 *
 * The impossibility is the entire licence, and its width is measured, not
 * assumed (`experiments/probe-text-rule.js`, delivered blocks, 28 decks):
 *
 *   shadda on a bare alef        10 touched,  7 fixed,    0 broken
 *   ANY combining mark on alef 1172 touched,  5 fixed, 1090 broken
 *
 * A fatha or damma on an alef is ordinary vocalisation, so the wide version
 * destroys the corpus. Only the shadda is impossible. Do not widen this.
 */
export const SHADDA_ON_ALEF = /([اآ])(ّ)/u;
const SHADDA_ON_ALEF_G = /([اآ])(ّ)/gu;

/**
 * EVERY ENTRY MUST BE GLOBAL. The check below reads these with `matchAll`, which
 * throws a TypeError on a non-global RegExp — and the throw happens inside the
 * doctor's per-object walk, where it is swallowed as "this rule found nothing".
 * Adding one anchored rule without `g` therefore silently switched off EVERY
 * numeric repair in the file: measured 0 fixed / 8 broken, on eight blocks that
 * had nothing to do with the new rule. The anchors make `g` a no-op, so it costs
 * nothing to be right.
 */
const NUMERIC_DAMAGE = [
  [/%(\d[\d.,]*)/gu, "$1%"],
  [/×\s*(\d[\d.,]*)\s+(\d[\d.,]*)/gu, "$1 × $2"],
  [/(\d[\d.,]*)%\s*–\s*(\d[\d.,]*)/gu, "$2–$1%"],

  // A SIGNED NUMBER whose sign ended up behind it: `6−` for `−6`, `2+` for `+2`.
  // Anchored at BOTH ends, so it can only match a run that IS a signed number,
  // and a number written sign-last is not something this corpus writes — the
  // same licence every safe rule in this file has. 10 fixed / 0 broken.
  [/^(\d[\d.,]*)\s*([+\u2212-])$/gu, "$2$1"],

  // A whole arithmetic line reversed end for end: `95 = 55 + 40` for
  // `40 + 55 = 95`. Both readings are arithmetically TRUE, so the sum is not the
  // evidence — the anchors are. The run is ENTIRELY the equation, which is a
  // shape only the reversal produces. 4 fixed / 0 broken.
  //
  // THE GAPS ARE CAPTURED AND CARRIED WITH THE TERMS, never replaced by single
  // spaces. The first version wrote `"$4 $3 $2 = $1"`, which reads well and
  // INVENTS whitespace: a page painting `16=16+0` got back `0 + 16 = 16`, four
  // characters the source never drew. Those four blocks on Unit Five p74 are the
  // only text in that entire deck whose rendered width exceeds its box by more
  // than one em \u2014 +7.4pt each on an ~18pt box \u2014 and the CONSTANT offset across
  // strings of different lengths is the tell, because a shaping difference
  // scales with the string and invented spaces do not. An input that already
  // carries spaces round-trips unchanged, which is why the corpus can see this
  // in neither direction. Found by `experiments/factory`, item `tight-2`.
  [/^(\d[\d.,]*)(\s*)=(\s*)(\d[\d.,]*)(\s*)([+\u2212\u00d7\u00f7])(\s*)(\d[\d.,]*)$/gu,
    "$8$7$6$5$4$3=$2$1"],
];

// Asserted at load, not documented and hoped for.
for (const [re] of NUMERIC_DAMAGE) {
  if (!re.global) throw new Error(`NUMERIC_DAMAGE entry is not global: ${re}`);
}
export const repairNumericDirection = (s) =>
  NUMERIC_DAMAGE.reduce((t, [re, to]) => t.replace(re, to), s);
export const NUMERIC_REVERSED = (s) => repairNumericDirection(s) !== s;

// ARABIC_LETTER is declared once, above. A second definition of "what is an
// Arabic letter" in the same file is exactly the drift this project already had
// to merge away for the RTL rule.
const COMBINING = /[ً-ْٰ]/u;
const COMBINING_G = /[ً-ْٰ]/gu;

/**
 * Put the dropped alef back under its fathatan.
 *
 * Measured over all 28 decks, on the 113 blocks the detector flags, built up one
 * rule at a time so it is clear what each is worth
 * (`experiments/probe-tanween-repair.js`):
 *
 *   alef immediately before the fathatan            12 fixed,  0 broken
 *   alef at the end of the word                     56 fixed,  0 broken
 *     + keep letters stranded after the mark        71 fixed,  0 broken
 *     + lam-alef when the LINE owes 2 characters    80 fixed,  0 broken
 *     + lam-alef when a LIGATURE is unaccounted     91 fixed,  0 broken
 *
 * Three facts from the corpus, each of which changes the answer:
 *
 *  1. The mark belongs to the WORD, not to trailing punctuation, so it moves in
 *     front of it: `فور.ً` -> `فوراً.`, `دائم:ً` -> `دائماً:`.
 *  2. Letters can survive AFTER the stranded mark, so the word does not end
 *     where the mark is: `فوًر` -> `فوراً`, never `فواًر`.
 *  3. What goes back is `لا` when the page painted a lam-alef ligature the text
 *     cannot account for, and a bare alef otherwise. Deciding that from the
 *     line's TOTAL deficit instead makes `تنظيفً` into `تنظيفلاً`, because the
 *     missing character was somewhere else on the line.
 *
 * A rule tried and dropped: treating a shadda that follows the fathatan as the
 * misread alef. It reads plausibly, fixes `شهريًّ`, and costs a block elsewhere
 * — 91 fixed becomes 90 — so it is not here.
 */
export function repairStrandedFathatan(s, lamAlefLost) {
  const at = s.search(STRANDED_FATHATAN);
  if (at < 0) return s;
  const markAt = at + 1;

  let start = at;
  while (start >= 0 && !ARABIC_LETTER.test(s[start])) start--;
  if (start < 0) return s;

  let tail = markAt + 1;
  while (tail < s.length && (ARABIC_LETTER.test(s[tail]) || COMBINING.test(s[tail]))) tail++;

  // A mark sitting DIRECTLY on the base belongs to the base, and stripping it
  // deletes a letter's shadda. `between` exists to drop the marks of the letters
  // the fathatan was carried past, and it was taking this one with them:
  //
  //   شهريّاً   arrives as  ي ّ ً   (yeh, its shadda, the stranded fathatan)
  //   -> ي + "" + اً  =  شهرياً, the shadda gone
  //
  // Ten of the fourteen `DROPPED combining mark` misses were this one line, all
  // of them the `يّاً` ending: شهريّاً, سنويّاً, شخصيّاً, كميّاً.
  const mid = s.slice(start + 1, markAt);
  const onBase = /^[ً-ْٰ]*/u.exec(mid)[0];
  const between = mid.slice(onBase.length).replace(COMBINING_G, "");
  const carried = s.slice(markAt + 1, tail);
  const insert = (lamAlefLost ? "لا" : "ا") + "ً";

  return s.slice(0, start + 1) + onBase + carried + insert + between + s.slice(tail);
}

/** Fonts every Office install has, so a deck using only these travels anywhere. */
const UBIQUITOUS_FAMILIES = new Set(
  [
    "Calibri", "Calibri Light", "Cambria", "Cambria Math", "Arial", "Arial Black",
    "Times New Roman", "Courier New", "Georgia", "Tahoma", "Trebuchet MS", "Verdana",
    "Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol", "Wingdings", "Webdings", "Symbol",
  ].map((f) => f.toLowerCase())
);

/** Minimum type size that survives projection in a lecture hall. */
const TINY_PT = 9;
/**
 * That floor, expressed in the coordinates the PAGE is actually drawn in.
 *
 * A document whose pages are not all one size has the odd ones uniformly fitted
 * into the dominant canvas (`fitPagesToCanvas`), which scales their type down
 * along with everything else. On the 118-page Unit Five that scale is 0.651, so
 * an ordinary 10.5pt line arrives as 6.84pt and **1455 of the 1506 text objects
 * on the 31 fitted pages** read as "too small" — the whole page reported as a
 * defect nobody introduced. Worse, the fix then raised every one of them to a
 * flat 9pt inside boxes still sized for 5.3-7.8pt text, which overflowed each
 * box, collided with its neighbours and flattened the type hierarchy (5.29pt
 * and 7.82pt both became 9pt). That is the damage the user reported as "the ppt
 * is so bad, overlapping everywhere".
 *
 * A threshold in canvas points is really a claim about the SOURCE's type, so it
 * has to travel with the page's own fit or it measures the letterboxing.
 */
const tinyFor = (page) => TINY_PT * (page?.sourceFit?.scale ?? 1);
/** WCAG AA for body text. */
const MIN_CONTRAST = 4.5;
/** More distinct families than this on one slide reads as a font zoo. */
const MAX_FAMILIES = 4;
/** Above this many shapes a slide becomes unpleasant to edit by hand. */
const BUSY_SHAPES = 80;

// ------------------------------------------------------------- colour math --
const rgb = (hex) => {
  const h = String(hex || "000000").replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)].map((v) => (isNaN(v) ? 0 : v));
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};
const toHex = ([r, g, b]) => [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
/** Straight RGB distance is enough to pick the intended brand colour back out. */
const colorDistance = (a, b) => {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
};

// ---------------------------------------------------------------- identity --
/**
 * The document's identity — its palette and its faces — as captured from the
 * SOURCE at import time (`model.identity`, see src/model/normalize.js).
 *
 * The rules below compare the live model against that baseline, which is what
 * "the identity must be the same after PDF -> PPTX" actually means: not that the
 * deck matches some remembered brand sheet, but that nothing the app or an edit
 * did moved a colour or a face off what the source itself used. A deck with no
 * baseline (an older model) simply reports nothing rather than guessing.
 */
const identityOf = (m) => (m?.identity?.palette?.length ? m.identity : null);

/** Colours a brand-faithful object may use, plus pure black/white escape hatches. */
function paletteOf(m) {
  const id = identityOf(m);
  return id ? id.palette : null;
}

/** Nearest colour in the palette, so a fix RESTORES rather than invents. */
function snapToPalette(hex, palette) {
  let best = palette[0], bestD = Infinity;
  for (const c of palette) {
    const d = colorDistance(hex, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Identity of a typeface REQUEST, as one comparable key.
 *
 * Must stay in step with `faceId` in src/model/normalize.js, which builds the
 * baseline — the two have to split faces on the same axis or the check compares
 * different things. Family alone is not enough and the display label is worse:
 * "Lyon Arabic Text LF Bold" with no bold attribute and "Lyon Arabic Text LF"
 * plus bold read the same and are different requests (see KNOWN_ISSUES).
 * Duplicated rather than imported because this module is loaded straight by the
 * browser as well as by the CLI.
 */
const FACE_SEP = "\u001f";
const faceKey = (r) => [r.fontFamily, r.bold ? 1 : 0, r.italic ? 1 : 0].join(FACE_SEP);
const faceLabel = (r) => `${r.fontFamily}${r.bold ? " Bold" : ""}${r.italic ? " Italic" : ""}`;

/**
 * Drop the font-resolution verdict from a run whose face has just been changed.
 *
 * `weightRequested`/`weightApprox`/`fontSubstituted` describe a decision made
 * against the INSTALLED font list when the PDF was read, and only the server can
 * make that decision. Once the face changes in the browser they describe the old
 * font. Measured: repairing a run from Comic Sans back to Diodrum Arabic left
 * `weightSynthesised` set, and the panel then reported "Diodrum Arabic 700 is
 * not installed" — about a face that ships a real bold. Not knowing is fine and
 * reports nothing; asserting a stale verdict is not.
 */
export function forgetResolution(run) {
  delete run.weightRequested;
  delete run.weightDelivered;
  delete run.weightApprox;
  delete run.weightSynthesised;
  delete run.fontSubstituted;
  delete run.fontRequested;
}

/**
 * Whole-deck identity summary for the panel header.
 *
 * Deliberately separate from the findings list: "did the brand survive" is a
 * question about the deck, not a list of objects, and burying it among 40
 * warnings is how it goes unnoticed.
 */
export function identityReport(model) {
  const id = identityOf(model);
  if (!id) return { available: false };

  const palette = new Set(id.palette);
  const faces = new Set(id.faces.map((f) => f.id));

  let offColor = 0, offFace = 0, approxWeight = 0, substituted = 0, texts = 0, shapes = 0;
  const missing = new Map();

  for (const page of model.pages) {
    for (const o of page.objects) {
      if (o.type === "text") {
        texts++;
        for (const r of o.runs ?? []) {
          if (!palette.has(r.color)) offColor++;
          if (!faces.has(faceKey(r))) offFace++;
          if (r.weightApprox) {
            approxWeight++;
            const want = r.weightSynthesised
              ? `${r.fontFamily} at weight ${r.weightRequested} (faked from a lighter cut)`
              : `${r.fontFamily} at weight ${r.weightRequested} (drawn at ${r.weightDelivered})`;
            missing.set(want, (missing.get(want) ?? 0) + 1);
          }
          if (r.fontSubstituted) substituted++;
        }
      } else if (o.type === "shape") {
        shapes++;
        if (o.fill && !palette.has(o.fill)) offColor++;
        if (o.stroke && !palette.has(o.stroke)) offColor++;
      }
    }
  }

  return {
    available: true,
    palette: id.palette,
    faces: id.faces.map((f) => f.label),
    offColor,
    offFace,
    approxWeight,
    substituted,
    texts,
    shapes,
    // "Intact" is a strict claim, so it means exactly what it says: every colour
    // and every face is one the source used, and every weight is real.
    intact: offColor === 0 && offFace === 0 && approxWeight === 0 && substituted === 0,
    // Two very different failures, kept apart because the remedies are opposite:
    // DRIFTED means something in this app moved a colour or a face off the
    // source and can be repaired here; APPROXIMATED means the source is faithful
    // but this machine lacks a font file, which only installing it can fix.
    // Collapsing them into one word sent the user hunting for an edit that never
    // happened.
    state: offColor || offFace || substituted ? "drifted"
      : approxWeight ? "approximated"
      : "intact",
    missingFonts: [...missing.entries()].map(([label, count]) => ({ label, count })),
  };
}

/** The colour actually behind a text object: the topmost filled shape under it. */
function backdropOf(page, obj) {
  let best = page.background ?? "FFFFFF";
  for (const s of page.objects) {
    if (s.type !== "shape" || !s.fill || s.zIndex > obj.zIndex) continue;
    const covers =
      s.bbox.x <= obj.bbox.x + 1 && s.bbox.y <= obj.bbox.y + 1 &&
      s.bbox.x + s.bbox.w >= obj.bbox.x + obj.bbox.w - 1 &&
      s.bbox.y + s.bbox.h >= obj.bbox.y + obj.bbox.h - 1;
    if (covers) best = s.fill;
  }
  return best;
}

const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

// -------------------------------------------------------------------- rules --
export const RULES = [
  {
    id: "unmapped-source",
    title: "Source element not reconstructed",
    severity: "error",
    why: "Something visible in the PDF produced no object here, so it would vanish from the export.",
    check: (m) => (m._coverageErrors ?? []).map((e) => ({ page: e.page ?? 0, message: e.message })),
  },

  {
    id: "unsupported-shape",
    title: "Shape has no native PowerPoint equivalent",
    severity: "warn",
    why: "It will not survive as an editable shape and needs a fallback.",
    check: (m) => forObjects(m, (o) => o.type === "shape" && o.reconstructionStrategy === "unsupported",
      (o) => `${o.shapeType} cannot be drawn as a PowerPoint preset`),
  },

  {
    id: "suspect-dropped-alef",
    title: "Word may be missing a letter",
    severity: "warn",
    fixable: false,
    why: "A definite-article alef may be missing before a lam-alef ligature. Auto-correcting would mean inventing an Arabic letter, so this is flagged for you to check against the source page instead.",

    // RETIRED 2026-08-15 — measured 100% false positives, 0 true positives.
    //
    // The underlying extraction bug is fixed (src/extract/ligatures.js), and
    // this pattern never described the defect well anyway: "ولا" (and not),
    // "بلا" (without) and "فلا" are ordinary Arabic words. Measured across the
    // corpus with experiments/probe-alef-rule-precision.js:
    //
    //     55 blocks flagged · 55 correct · 0 genuinely wrong
    //     most flagged: بلا x23, ولا x18, فلا x6, الكلاسيكية, مشكلاته
    //
    // It was the top finding in the panel, it depressed the deck score, and it
    // asked the user to hand-check 55 correct words. A warning that is wrong
    // every time is worse than no warning, so the check is disabled rather than
    // deleted: if the ligature repair ever regresses, the right response is a
    // rule that detects the real fault, not this one revived.
    check: () => [],
  },

  {
    id: "font-substituted",
    title: "Font is not installed",
    severity: "warn",
    fixable: false,
    why: "PowerPoint will pick a different face, changing metrics and line breaks. Install the font rather than letting the app silently swap it.",
    check: (m) => forObjects(m, (o) => o.type === "text" && o.runs?.some((r) => r.fontSubstituted),
      (o) => `${[...new Set(o.runs.filter((r) => r.fontSubstituted).map((r) => r.fontRequested))].join(", ")} is missing`),
  },

  {
    id: "tiny-text",
    title: "Text too small to read when projected",
    severity: "warn",
    fixable: true,
    // Enlarging type makes the slide DIFFER from the source. That is a design
    // decision, not a defect repair, so fix-all leaves it alone unless asked.
    changesDesign: true,
    why: `Below ${TINY_PT}pt nothing survives a lecture-hall projector — but this is the source's own size, so changing it moves the slide away from the original.`,
    check: (m) => forObjects(m,
      (o, page) => o.type === "text" && o.runs?.some((r) => r.fontSizePt < tinyFor(page)),
      (o, page) => `${Math.min(...o.runs.map((r) => r.fontSizePt))}pt is below ${+tinyFor(page).toFixed(2)}pt`),
    fix: (o, page) => {
      const floor = tinyFor(page);
      o.runs.forEach((r) => { if (r.fontSizePt < floor) r.fontSizePt = floor; });
    },
  },

  {
    id: "low-contrast",
    title: "Text does not contrast with its background",
    severity: "warn",
    fixable: true,
    changesDesign: true,
    why: `Below ${MIN_CONTRAST}:1 the text is hard to read, and worse through a projector.`,
    check: (m) => forObjects(m, (o, page) => {
      if (o.type !== "text" || !o.runs?.length) return false;
      const bg = backdropOf(page, o);
      return o.runs.some((r) => contrast(r.color, bg) < MIN_CONTRAST);
    }, (o, page) => {
      const bg = backdropOf(page, o);
      const worst = Math.min(...o.runs.map((r) => contrast(r.color, bg)));
      return `${worst.toFixed(2)}:1 against #${bg}`;
    }),
    fix: (o, page) => {
      const bg = backdropOf(page, o);
      const light = luminance(bg) < 0.5;
      for (const r of o.runs) {
        if (contrast(r.color, bg) >= MIN_CONTRAST) continue;
        // Walk the run's own colour toward white or black until it passes, so
        // the hue is preserved rather than being flattened to pure black.
        let c = rgb(r.color);
        for (let i = 0; i < 24 && contrast(toHex(c), bg) < MIN_CONTRAST; i++) {
          c = c.map((v) => (light ? v + (255 - v) * 0.18 : v * 0.82));
        }
        r.color = toHex(c);
      }
    },
  },

  {
    id: "off-slide",
    title: "Object sits outside the slide",
    severity: "warn",
    fixable: true,
    why: "Anything past the slide edge is invisible in the export and in presentation mode.",
    check: (m) => forObjects(m, (o, page) =>
      o.bbox.x + o.bbox.w < 0 || o.bbox.y + o.bbox.h < 0 ||
      o.bbox.x > page.widthPt || o.bbox.y > page.heightPt,
      () => "entirely outside the slide box"),
    fix: (o, page) => {
      o.bbox.x = Math.max(0, Math.min(o.bbox.x, page.widthPt - o.bbox.w));
      o.bbox.y = Math.max(0, Math.min(o.bbox.y, page.heightPt - o.bbox.h));
    },
  },

  {
    id: "zero-size",
    title: "Object has no size",
    severity: "warn",
    fixable: true,
    why: "A zero-width or zero-height shape cannot be selected or seen.",
    check: (m) => forObjects(m, (o) => o.bbox.w <= 0.05 || o.bbox.h <= 0.05,
      (o) => `${o.bbox.w}×${o.bbox.h}pt`),
    fix: (o) => { o.bbox.w = Math.max(o.bbox.w, 0.5); o.bbox.h = Math.max(o.bbox.h, 0.5); },
  },

  {
    id: "rtl-missing",
    title: "Arabic paragraph is not right-to-left",
    severity: "error",
    fixable: true,
    why: "Without RTL the paragraph renders in the wrong order in PowerPoint. A line that genuinely runs left-to-right is exempt: a formula, and a reference list entry, keep their direction even when they carry Arabic.",
    // The exemption is not cosmetic. "Contains Arabic" is not the question — if
    // it were, this rule would fire on every line like "8 × 60 = 480 دقيقة",
    // report an ERROR, and its fix would force the direction back to rtl,
    // undoing the reconstruction that made the line correct. Measured then:
    // 6 of 6 decks went to exit 3. Measured again when reference entries learned
    // to be LTR: 4 more false errors on one deck's bibliography page. The
    // question is the one the extractor answered, so this asks it the same way.
    check: (m) => forObjects(m, (o) => o.type === "text" && ARABIC_LETTER.test(o.text) &&
      o.paragraphDirection !== "rtl" && textIsRtl(o.text),
      () => "reads right-to-left but direction is ltr"),
    // `paragraphDirection` and not `sourceStreamDirection`: this rule is about
    // what SHIPS. Flipping the reconstruction flag after the fact would change
    // nothing anyway — the text was already reordered with the old answer.
    fix: (o) => { o.paragraphDirection = "rtl"; o.alignment = "right"; },
  },

  {
    id: "mixed-numerals",
    title: "Two numeral systems on one slide",
    severity: "warn",
    fixable: true,
    changesDesign: true,
    why: "Arabic-Indic (٠١٢) beside Western (012) reads as an inconsistency to students.",
    check: (m) => m.pages.flatMap((page, pi) => {
      const text = page.objects.filter((o) => o.type === "text").map((o) => o.text).join(" ");
      return ARABIC_DIGIT.test(text) && WESTERN_DIGIT.test(text)
        ? [{ page: pi, message: "slide mixes ٠-٩ and 0-9" }] : [];
    }),
    fix: null,
    fixPage: (page) => {
      // Western is the corpus default; convert the Arabic-Indic ones to match.
      const map = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
      for (const o of page.objects) {
        if (o.type !== "text") continue;
        const conv = (s) => s.replace(/[٠-٩]/g, (c) => map[c]);
        o.text = conv(o.text);
        o.runs?.forEach((r) => (r.text = conv(r.text)));
      }
    },
  },

  {
    id: "font-zoo",
    title: "Too many font families on one slide",
    severity: "warn",
    why: `More than ${MAX_FAMILIES} families makes a slide look assembled rather than designed.`,
    check: (m) => m.pages.flatMap((page, pi) => {
      const fams = new Set(page.objects.filter((o) => o.type === "text").flatMap((o) => o.runs?.map((r) => r.fontFamily) ?? []));
      return fams.size > MAX_FAMILIES ? [{ page: pi, message: `${fams.size} families: ${[...fams].join(", ")}` }] : [];
    }),
  },

  {
    id: "empty-text",
    title: "Empty text box",
    severity: "warn",
    fixable: true,
    why: "An empty box is invisible but still selectable, and clutters editing.",
    check: (m) => forObjects(m, (o) => o.type === "text" && !String(o.text).trim(), () => "no content"),
    fix: null,
    removes: true,
  },

  {
    id: "bidi-damaged-call",
    title: "Formula reads backwards",
    severity: "error",
    fixable: true,
    why: "A spreadsheet call inside an Arabic sentence came out with its brackets and '=' at the wrong ends — '=STDEV.P()' as ')(STDEV.P='. The characters are all there, the order is not, so it reads as broken text on the slide.",

    // MEASURED across the corpus (6 decks, 2454 blocks): this exact shape occurs
    // 9 times and every one is genuinely damaged — )(SUMIFS= )(STDEV.P=
    // )(STDEV.S= )(IF= )(AVERAGE=. Zero false positives.
    //
    // The pattern is deliberately narrow: a run that is ENTIRELY a leading ")("
    // plus an identifier plus a trailing "=". That is not text anyone writes, so
    // there is nothing legitimate for it to catch. The general repair — undoing
    // UAX#9 L4 mirroring inside R-classed units — was measured and costs 275
    // verbatim blocks (86.47% -> 75.26%), which is why this fixes the one shape
    // it can prove rather than the class it belongs to. See KNOWN_ISSUES.
    check: (m) => forObjects(m, (o) => o.type === "text" && (o.runs ?? []).some((r) => DAMAGED_CALL.test(r.text)),
      (o) => {
        const bad = o.runs.filter((r) => DAMAGED_CALL.test(r.text)).map((r) => r.text.trim());
        return `${bad.join(", ")} should read ${bad.map(repairCall).join(", ")}`;
      }),
    fix: (o) => {
      for (const r of o.runs ?? []) if (DAMAGED_CALL.test(r.text)) r.text = r.text.replace(DAMAGED_CALL, repairCall);
      // The block's own text is what the export and every metric read, so it has
      // to move with the runs or the fix is cosmetic in the panel only.
      o.text = (o.runs ?? []).map((r) => r.text).join("");
    },
  },

  {
    id: "broken-characters",
    title: "Text contains characters that should never reach the slide",
    severity: "error",
    fixable: false,
    why: "Arabic presentation forms, replacement characters or mojibake mean the text was damaged somewhere between the PDF and here. Repairing it automatically would mean guessing at Arabic letters, so it is flagged for you to check against the source page.",

    // Three distinct corruptions, one rule, because the user-visible symptom is
    // identical: text that looks wrong on the slide.
    //   - Arabic presentation forms (FB50-FDFF, FE70-FEFF) are shaped glyph
    //     codepoints. Production output has ZERO of them across 110,048
    //     characters; any that appear mean the extractor regressed. The FE00-FE0F
    //     variation selectors are NOT in the range on purpose: every "⚠️" in the
    //     corpus carries U+FE0F and is perfectly correct (23 blocks would
    //     otherwise be flagged, all of them wrong).
    //   - U+FFFD is irreversible loss (EVO-012, PowerShell re-encoding).
    //   - "Ã"/"â€" are UTF-8 read as a single-byte codepage.
    check: (m) => forObjects(m, (o) => o.type === "text" && BROKEN_CHARS.test(o.text),
      (o) => {
        const found = [...new Set(o.text.match(BROKEN_CHARS_G) ?? [])].slice(0, 6);
        return `contains ${found.map((c) => `${JSON.stringify(c)} U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join(", ")}`;
      }),
  },

  {
    id: "characters-missing",
    title: "This line is missing letters the page actually paints",
    severity: "error",
    fixable: false,
    why: "The PDF paints more characters on this line than the extractor recovered, so letters were lost — `يفصّل` arrives as `يفل`, `دائماً:` as `دائم:ً`. Nothing in the text itself gives this away: both readings are ordinary Arabic, which is why no spell-style rule can find it. The count comes from the document, not from a guess, so this line IS wrong. It cannot be repaired automatically — that would mean inventing Arabic — so open Compare and read the line off the source page.",

    // The one defect class in this project that is invisible in the output and
    // still provable from the input. Every painted glyph is answerable for a
    // known number of characters (a lam-alef presentation form owes two, an
    // ordinary glyph owes one); when that total exceeds what structured text
    // supplied on the same baseline, characters were dropped.
    //
    // Measured over all 28 decks, 10206 blocks (experiments/probe-suspicion.js),
    // against a 6.0% base rate:
    //
    //   device owes MORE than stext supplied   107 flagged, 107 wrong, 100.0%
    //   any unnamed device glyph              1175 flagged, 112 wrong,   9.5%
    //
    // The second is the rule intuition reaches for and it is worthless — unnamed
    // glyphs are everywhere and nearly always harmless. Only the first is used.
    //
    // The verdict is computed server-side at import (`charactersMissing` in
    // src/extract/glyphs.js) because it needs the device glyph walk, which the
    // browser has no way to perform; it rides on the object so the doctor can
    // read it here.
    check: (m) => forObjects(m, (o) => o.type === "text" && o.charactersMissing > 0,
      (o) => `${o.charactersMissing} character(s) painted on this line did not reach the text`),
  },

  {
    id: "lam-alef-reversed",
    title: "The definite article came out backwards",
    severity: "error",
    fixable: true,
    why: "`الإجراء` arrives as `اإلجراء`, `الاختناق` as `االختناق`. A lam-alef is one painted glyph standing for two characters, and when its halves are emitted alef-first they end up the wrong way round. It reads as a real word to anyone skimming, which is why it survives proofreading. The repair is safe because an alef followed by another alef form is not something Arabic writes: measured over all 28 decks, 20 fixed and 0 broken.",
    check: (m) => forObjects(m, (o) => o.type === "text" && REVERSED_ARTICLE.test(o.text),
      (o) => {
        const bad = [...o.text.matchAll(REVERSED_ARTICLE_G)].slice(0, 3)
          .map((mm) => `"${o.text.slice(Math.max(0, mm.index - 1), mm.index + 6)}"`);
        return `${bad.join(", ")} — the article's lam and alef are swapped`;
      }),
    fix: (o) => {
      // Per RUN, like every other text repair here: the block's text is the runs
      // joined, so rewriting it alone desyncs the runs the export reads. All
      // three characters are Arabic and runs split by script, so they travel
      // together.
      let changed = false;
      for (const r of o.runs ?? []) {
        const after = r.text.replace(REVERSED_ARTICLE_G, "ال$1");
        if (after !== r.text) { r.text = after; changed = true; }
      }
      if (changed) o.text = (o.runs ?? []).map((r) => r.text).join("");
    },
  },

  {
    id: "tanween-missing-alef",
    title: "A fathatan is sitting on a letter that lost its alef",
    severity: "error",
    fixable: true,
    why: "Fathatan (the double-fatha of the indefinite accusative) is written on a final alef — `مساراً`, `مختلفاً`. When it turns up on a bare consonant the alef under it was dropped during extraction: `مساراً` became `مسارً`, `دائماً:` became `دائم:ً`. Both the defect and the repair are facts about Arabic orthography plus what the page actually painted, not guesses about this document: measured over all 28 decks, the fix corrects 91 of 113 flagged lines and breaks none. The 22 it cannot reach stay flagged for you.",

    // A language rule, so it needs no device evidence and re-evaluates live after
    // an edit, unlike `characters-missing`. Measured over all 28 decks, 10206
    // blocks (experiments/probe-suspicion.js), against a 6.0% base rate:
    //
    //   fathatan with no alef on EITHER side   113 flagged, 113 wrong, 100.0%
    //   fathatan not preceded by an alef       114 flagged, 113 wrong,  99.1%
    //
    // BOTH SIDES IS THE WHOLE RULE. `مختلفاً` writes the mark after its alef and
    // `قممًا` writes it before; both are ordinary spellings, and the one-sided
    // test's single false positive over the whole corpus was exactly `قممًا`.
    // ة, ء and the hamza-carrying alefs legitimately carry fathatan, so they
    // count as an alef here.
    //
    // Together with `characters-missing` this reaches 139 blocks at 100%
    // precision — the two overlap on 81, so each one earns its place.
    check: (m) => forObjects(m, (o) => o.type === "text" && STRANDED_FATHATAN.test(o.text),
      (o) => {
        // Report the WORD, not the two matched characters. "\".ً\" — fathatan on
        // \".\"" is accurate and useless: the user has to find it in the line.
        const at = o.text.search(STRANDED_FATHATAN);
        const before = o.text.slice(0, at + 1).split(/\s/).pop();
        const after = o.text.slice(at + 1).split(/\s/)[0];
        return `"${before}${after}" — the alef under its fathatan is missing`;
      }),
    fix: (o) => {
      // Per RUN, not per block: the block's text is the runs joined, so rewriting
      // it alone desyncs the runs the export actually reads. The word and its
      // mark are Arabic, and runs split by script, so they travel together.
      let changed = false;
      for (const r of o.runs ?? []) {
        if (!STRANDED_FATHATAN.test(r.text)) continue;
        const after = repairStrandedFathatan(r.text, o.lamAlefLost);
        if (after !== r.text) { r.text = after; changed = true; }
      }
      if (changed) o.text = (o.runs ?? []).map((r) => r.text).join("");
    },
  },

  {
    id: "numeric-direction",
    title: "A number and its operator came out back to front",
    severity: "error",
    fixable: true,
    why: "Arabic writes `90%`, `4 × 4` and `5–10%` left-to-right exactly as English does, but every character in those is a digit or a neutral, and a run of neutrals inside an RTL paragraph takes the paragraph's direction — so the sign drifts to the wrong end and the ends of a range trade places. `90%` arrives as `%90`, `4 × 4` as `× 4 4`, `5–10%` as `10%–5`. Nothing is missing; the reading order is wrong, and the arithmetic on the slide reads as something the source never said. Both operands must be numbers for this to fire: measured over all 28 decks, 12 fixed and 0 broken.",
    check: (m) => forObjects(m, (o) => o.type === "text" && NUMERIC_REVERSED(o.text),
      (o) => {
        const bad = [];
        for (const [re] of NUMERIC_DAMAGE) {
          for (const mm of o.text.matchAll(re)) { bad.push(`"${mm[0]}"`); if (bad.length >= 3) break; }
          if (bad.length >= 3) break;
        }
        return `${bad.join(", ")} — the number and its operator are the wrong way round`;
      }),
    fix: (o) => {
      // Per RUN, like every other text repair here. Runs split by SCRIPT, and
      // every character of these expressions is a digit or a neutral, so an
      // expression cannot straddle a run boundary — the whole island is one run.
      let changed = false;
      for (const r of o.runs ?? []) {
        const after = repairNumericDirection(r.text);
        if (after !== r.text) { r.text = after; changed = true; }
      }
      if (changed) o.text = (o.runs ?? []).map((r) => r.text).join("");
    },
  },

  {
    id: "shadda-on-alef",
    title: "A shadda landed on an alef",
    severity: "error",
    fixable: true,
    why: "Shadda marks a doubled consonant, and the alef it is sitting on is a long vowel — Arabic does not double it, so `اّ` is not a sequence the language writes. The mark belongs to the letter before the alef and was sorted past it during reconstruction. Because the sequence is impossible rather than merely unusual, putting the mark back is a reading of the orthography and not a guess: measured over all 28 decks, 7 fixed and 0 broken. Widening it to any combining mark on an alef breaks 1090 blocks, because a fatha or damma there is ordinary vocalisation.",
    check: (m) => forObjects(m, (o) => o.type === "text" && SHADDA_ON_ALEF.test(o.text),
      (o) => {
        const at = o.text.search(SHADDA_ON_ALEF);
        const word = o.text.slice(0, at + 2).split(/\s/).pop() + o.text.slice(at + 2).split(/\s/)[0];
        return `"${word}" — the shadda belongs to the letter before the alef`;
      }),
    fix: (o) => {
      // Per RUN, like every other text repair here: the block's text is the runs
      // joined. Both characters are Arabic and runs split by script, so the pair
      // cannot straddle a boundary.
      let changed = false;
      for (const r of o.runs ?? []) {
        const after = r.text.replace(SHADDA_ON_ALEF_G, "$2$1");
        if (after !== r.text) { r.text = after; changed = true; }
      }
      if (changed) o.text = (o.runs ?? []).map((r) => r.text).join("");
    },
  },

  {
    id: "deck-not-portable",
    title: "The fonts will not travel with this deck",
    severity: "error",
    fixable: false,
    why: "This deck uses fonts that are installed on THIS machine only. Without embedding them, PowerPoint on someone else's computer substitutes a font that has no Arabic glyphs — the text turns into boxes or unrelated CJK glyphs. Export embeds the fonts automatically; this fires when it cannot, and the deck should not be sent until it can.",

    // Portability is an EXPORT fact, not a model fact, so the server tells the
    // model whether embedding is possible (`_canEmbed`). Undefined means nobody
    // asked — stay quiet rather than cry wolf in the CLI.
    check: (m) => {
      if (m._canEmbed !== false) return [];
      const families = new Set(
        m.pages.flatMap((p) => p.objects.flatMap((o) => (o.runs ?? []).map((r) => r.fontFamily)))
      );
      const atRisk = [...families].filter((f) => f && !UBIQUITOUS_FAMILIES.has(f.toLowerCase()));
      if (!atRisk.length) return [];
      return [{ page: 0, message: `${atRisk.join(", ")} cannot be embedded here (${m._canEmbedReason ?? "PowerPoint is unavailable"}) — the deck will not render correctly for anyone else` }];
    },
  },

  {
    id: "overlapping-text",
    title: "Text boxes overlap",
    severity: "info",
    why: "Usually means one paragraph was split into two blocks, which makes editing awkward.",
    check: (m) => m.pages.flatMap((page, pi) => {
      const texts = page.objects.filter((o) => o.type === "text");
      const out = [];
      for (let i = 0; i < texts.length; i++) {
        for (let j = i + 1; j < texts.length; j++) {
          const a = texts[i], b = texts[j];
          const area = overlapArea(a.bbox, b.bbox);
          const smaller = Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h);
          if (smaller > 0 && area / smaller > 0.6) {
            out.push({ page: pi, objectId: a.id, message: `overlaps ${b.id}` });
          }
        }
      }
      return out;
    }),
  },

  {
    id: "busy-slide",
    title: "Slide has a lot of shapes",
    severity: "info",
    why: `Above ${BUSY_SHAPES} shapes a slide is technically fine but tiring to edit by hand.`,
    check: (m) => m.pages.flatMap((page, pi) => {
      const n = page.objects.filter((o) => o.type === "shape").length;
      return n > BUSY_SHAPES ? [{ page: pi, message: `${n} shapes` }] : [];
    }),
  },

  {
    id: "identity-colour",
    title: "Colour is not in the document's palette",
    severity: "warn",
    fixable: true,
    why: "This colour is not one the source PDF uses anywhere, so something moved off-brand after import. The fix snaps it back to the nearest colour the source actually used.",
    check: (m) => {
      const palette = paletteOf(m);
      if (!palette) return [];
      const known = new Set(palette);
      return forObjects(m, (o) => {
        if (o.type === "text") return (o.runs ?? []).some((r) => !known.has(r.color));
        if (o.type === "shape") return (o.fill && !known.has(o.fill)) || (o.stroke && !known.has(o.stroke));
        return false;
      }, (o) => {
        const off = o.type === "text"
          ? [...new Set((o.runs ?? []).filter((r) => !known.has(r.color)).map((r) => r.color))]
          : [o.fill, o.stroke].filter((c) => c && !known.has(c));
        return `#${off.join(", #")} is not in the source palette`;
      });
    },
    // The palette is captured from the SOURCE at import and never recomputed, so
    // this cannot drift into snapping colours to each other: the target is fixed
    // however many off-brand objects there are (see EVO-009 — a fix that elects
    // its target from the current page lets a numerous offender win the vote).
    fix: (o, page, m) => {
      const palette = paletteOf(m);
      if (!palette) return;
      const snap = (c) => (palette.includes(c) ? c : snapToPalette(c, palette));
      if (o.type === "text") o.runs?.forEach((r) => { r.color = snap(r.color); });
      else { if (o.fill) o.fill = snap(o.fill); if (o.stroke) o.stroke = snap(o.stroke); }
    },
  },

  {
    id: "identity-font",
    title: "Typeface is not one the document uses",
    severity: "warn",
    fixable: true,
    why: "A face the source never uses breaks the deck's typography. The fix restores the source's most-used face at this weight.",
    check: (m) => {
      const id = identityOf(m);
      if (!id) return [];
      const known = new Set(id.faces.map((f) => f.id));
      return forObjects(m, (o) => o.type === "text" && (o.runs ?? []).some((r) => !known.has(faceKey(r))),
        (o) => `${[...new Set(o.runs.filter((r) => !known.has(faceKey(r))).map(faceLabel))].join(", ")} is not a face of this document`);
    },
    // `id.faces` is ordered by ink and captured from the SOURCE, so the target is
    // fixed no matter how many objects are off-brand. A fix that elected its
    // target from the current page would let a numerous offender vote itself in
    // and never converge (EVO-009).
    fix: (o, page, m) => {
      const id = identityOf(m);
      if (!id?.faces?.length) return;
      const known = new Set(id.faces.map((f) => f.id));
      for (const r of o.runs ?? []) {
        if (known.has(faceKey(r))) continue;
        // Prefer a source face of the same weight, so a bold run stays bold —
        // and copy BOTH parts, because whether the weight lives in the family
        // name or in the attribute differs per family.
        const pick = id.faces.find((f) => Boolean(f.bold) === Boolean(r.bold) && Boolean(f.italic) === Boolean(r.italic))
          ?? id.faces.find((f) => Boolean(f.bold) === Boolean(r.bold))
          ?? id.faces[0];
        r.fontFamily = pick.family;
        r.bold = Boolean(pick.bold);
        r.italic = Boolean(pick.italic);
        forgetResolution(r);
      }
    },
  },

  {
    id: "font-weight-approximated",
    title: "Weight is faked because the real cut is not installed",
    severity: "warn",
    fixable: false,
    why: "The source asks for a weight this machine has no font file for, so PowerPoint smears a lighter cut to imitate it. Installing the real cut is the only true fix — inventing one here would just hide the difference.",
    // MEASURED 2026-08-15: the title slide asks for Cairo at weight 700 and only
    // Cairo Regular is installed. Faking it recovers most of the difference
    // (heading ink 72% -> 85% of the source) but not all of it, and silence
    // about the remainder is what let the thin headings ship in the first place.
    check: (m) => forObjects(m, (o) => o.type === "text" && (o.runs ?? []).some((r) => r.weightApprox),
      (o) => {
        const bad = o.runs.filter((r) => r.weightApprox);
        // "Cairo 700 - drawn at 700" was true and told the reader nothing. The
        // whole point is WHICH cut is missing and what happens instead.
        const said = [...new Set(bad.map((r) => r.weightSynthesised
          ? `${r.fontFamily} ${r.weightRequested} is not installed — faked by smearing the regular cut`
          : `${r.fontFamily} ${r.weightRequested} is not installed — drawn at ${r.weightDelivered} instead`))];
        return said.join("; ");
      }),
  },

  {
    id: "duplicate-slide",
    title: "Two slides have identical text",
    severity: "info",
    fixable: false,
    why: "Usually a forgotten copy. Deleting the wrong one loses content, so this is yours to decide.",
    check: (m) => {
      const seen = new Map(); const out = [];
      m.pages.forEach((page, pi) => {
        const key = page.objects.filter((o) => o.type === "text").map((o) => o.text).join("|").trim();
        if (!key) return;
        if (seen.has(key)) out.push({ page: pi, message: `same text as slide ${seen.get(key) + 1}` });
        else seen.set(key, pi);
      });
      return out;
    },
  },
];

/** Helper: run an object-level predicate across the deck. */
function forObjects(model, pred, describe) {
  const out = [];
  model.pages.forEach((page, pi) => {
    for (const o of page.objects) {
      if (pred(o, page)) out.push({ page: pi, objectId: o.id, message: describe(o, page) });
    }
  });
  return out;
}

// ------------------------------------------------------------------ runner --
const WEIGHT = { error: 12, warn: 4, info: 1 };

/** Run every rule and score the deck. */
export function runDoctor(model, coverage) {
  const m = { ...model, _coverageErrors: coverage?.detail?.filter((d) => d.severity === "error") ?? [] };
  const findings = [];

  for (const rule of RULES) {
    let hits = [];
    try { hits = rule.check(m) ?? []; } catch (e) { hits = [{ page: 0, message: `rule failed: ${e.message}` }]; }
    for (const h of hits) {
      findings.push({
        rule: rule.id,
        title: rule.title,
        severity: rule.severity,
        why: rule.why,
        fixable: Boolean(rule.fix || rule.fixPage || rule.removes),
        changesDesign: Boolean(rule.changesDesign),
        ...h,
      });
    }
  }

  // Score is DECK-RELATIVE. A flat penalty per finding drives any real deck to
  // zero — 43 warnings across 933 objects is a 4.6% defect rate, not a failure —
  // and a score that is always zero tells the user nothing.
  const objects = model.pages.reduce((n, p) => n + p.objects.length, 0) || 1;
  const penalty = findings.reduce((n, f) => n + (WEIGHT[f.severity] ?? 1), 0);
  const score = Math.max(0, Math.round(100 - Math.min(100, (penalty / objects) * 100)));

  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return { score, counts, findings, objects, clean: findings.length === 0 };
}

/**
 * Split what is left into the three honest categories, so the UI can say WHY
 * something was not fixed instead of leaving the user to guess.
 *
 * `now` is what pressing the button again would actually repair; if that is zero
 * and findings remain, the remainder is either opt-in design work or genuinely a
 * human's call.
 */
export function triageFindings(findings, { includeDesign = false } = {}) {
  const design = findings.filter((f) => f.fixable && f.changesDesign);
  const manual = findings.filter((f) => !f.fixable);
  const now = findings.filter((f) => f.fixable && (includeDesign || !f.changesDesign));
  return { total: findings.length, now: now.length, design: design.length, manual: manual.length };
}

/** A finding's stable identity, for telling one scan's results from the next. */
const findingKey = (f) => `${f.rule}|${f.page}|${f.objectId ?? ""}`;

/** One repair sweep over a single scan's findings. Returns how many applied. */
function fixOnce(model, findings, byId, ruleId, includeDesign) {
  let applied = 0;
  for (const f of findings) {
    if (ruleId && f.rule !== ruleId) continue;
    const rule = byId.get(f.rule);
    if (!rule) continue;
    // Design changes move the slide away from the source; opt in explicitly.
    if (rule.changesDesign && !includeDesign && !ruleId) continue;
    const page = model.pages[f.page];
    if (!page) continue;

    if (rule.removes) {
      const i = page.objects.findIndex((o) => o.id === f.objectId);
      if (i >= 0) { page.objects.splice(i, 1); applied++; }
      continue;
    }
    if (rule.fixPage) { rule.fixPage(page, model); applied++; continue; }
    if (rule.fix && f.objectId) {
      const obj = page.objects.find((o) => o.id === f.objectId);
      if (obj) { rule.fix(obj, page, model); applied++; }
    }
  }
  return applied;
}

/**
 * Apply every fixable finding for one rule (or all rules when ruleId is null).
 *
 * RE-SCANS AFTER EVERY SWEEP. A single pass is not enough and the failure is not
 * theoretical: measured on Chp1-Lec1-3, one sweep repaired 5 zero-size boxes and
 * thereby CREATED a new overlapping-text finding (1 -> 2), because a box with no
 * area cannot overlap anything and a repaired one can. A fixer that never looks
 * again reports "fixed 5" while leaving the deck in a state it has never
 * inspected.
 *
 * The loop stops when a sweep applies nothing, or when the set of findings stops
 * changing — two fixes that undo each other would otherwise spin — and it is
 * capped so a rule with a genuinely unstable repair cannot hang the editor. What
 * remains after the loop is reported, never assumed to be zero.
 */
export function applyFixes(model, ruleId = null, { includeDesign = false, maxPasses = 6 } = {}) {
  const byId = new Map(RULES.map((r) => [r.id, r]));
  let applied = 0, passes = 0;
  let after = runDoctor(model, null);
  let seen = after.findings.map(findingKey).sort().join(";");

  for (; passes < maxPasses; passes++) {
    const n = fixOnce(model, after.findings, byId, ruleId, includeDesign);
    if (!n) break;
    applied += n;
    after = runDoctor(model, null);
    const now = after.findings.map(findingKey).sort().join(";");
    if (now === seen) { passes++; break; }   // this sweep changed nothing; stop
    seen = now;
  }

  return {
    applied,
    passes,
    after,
    remaining: triageFindings(after.findings, { includeDesign }),
    // True only when another press would still repair something — the honest
    // signal for "we stopped early" rather than "we finished".
    converged: triageFindings(after.findings, { includeDesign }).now === 0,
  };
}
