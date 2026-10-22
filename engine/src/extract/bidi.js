/**
 * Visual -> logical text reconstruction for PDFs whose glyphs were positioned
 * individually by the producing engine (Chromium, wkhtmltopdf, InDesign...).
 *
 * WHY THIS EXISTS
 * A PDF stores glyphs in the order and position they were PAINTED, which for
 * Arabic is visual order (right-to-left text laid out left-to-right on the
 * page). The logical string a human typed is the reverse, except for embedded
 * Latin/number "islands" which stay left-to-right, and paired brackets which
 * the layout engine already mirrored on the way in.
 *
 * We do NOT use the bidi level MuPDF reports per char: measured on the real
 * corpus it returns levels {0,1,3} in a pattern that does not correspond to
 * UAX#9 embedding levels for these documents, and reversing by it produces
 * scrambled lines. Character class + known base direction is deterministic and
 * measurable, so that is what we use.
 */

const RE_RTL = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-ﭏﭐ-﷿ﹰ-﻿]/;
/**
 * Latin letters, and NOT the two operators Unicode put among them.
 *
 * U+00D7 MULTIPLICATION SIGN and U+00F7 DIVISION SIGN sit inside Latin-1
 * Supplement, between the accented letters, so the obvious range À-ɏ classes
 * `×` and `÷` as STRONG LTR. An operator between two numbers in an Arabic line
 * then forms an LTR island of its own and the reversal places it as a unit,
 * carrying it out of its own expression:
 *
 *   visual  2000 = 4√ × 1000        got  × 1000 √4 = 2000
 *                                   truth    1000 × √4 = 2000
 *
 * Measured over the remaining miss set: 39 blocks, spread across SEVEN of the
 * diff classifier's buckets — `digit wrong`, `other substitution`, `EXTRA char
 * "²"`, `space misplaced` and three more. The bucket names the diff, never the
 * cause.
 */
const RE_LTR = /[A-Za-zÀ-ÖØ-öø-ɏͰ-ϿЀ-ӿ]/;
const RE_NUM = /[0-9]/;
/**
 * Bidi_Class AN — the Arabic-Indic digits, and the two separators that live
 * INSIDE a number written with them.
 *
 * U+066B ARABIC DECIMAL SEPARATOR and U+066C ARABIC THOUSANDS SEPARATOR are
 * Bidi_Class AN in their own right, not neutrals and not letters. Left out, they
 * classify as strong R (they sit in the Arabic block) and SPLIT one number into
 * two AN islands with an R between them, so the whole thing reverses around the
 * separator: measured on authored strings, `٣٫١٤` came back `١٤٫٣` and `١٬٠٠٠`
 * came back `٠٠٠٬١` — pi as fourteen point three.
 *
 * U+066A ARABIC PERCENT SIGN is deliberately NOT here: it is Bidi_Class ET, it
 * sits at the edge of a number rather than inside it, and the authored case
 * `٪٢٥` already round-trips exactly. One axis at a time.
 */
const RE_AN = /[٠-٩۰-۹٫٬]/;

/** Bidi character classes we care about. */
export const CLS = { R: "R", L: "L", EN: "EN", AN: "AN", N: "N" };

export function classify(ch) {
  // AN BEFORE R, and the order is the whole rule. The Arabic-Indic digits live
  // INSIDE the Arabic block — U+0660-0669 sits in the middle of `؀-ۿ`
  // (U+0600-06FF) — so testing RE_RTL first classed every one of them as strong
  // R and made RE_AN, correct and sitting right below it, dead code.
  //
  // The consequence is not cosmetic: an Arabic number is bidi class AN, which
  // UAX#9 I1/I2 raises to an even level inside an RTL paragraph, so its digits
  // are laid out LEFT TO RIGHT. Classed R they were reversed along with the
  // Arabic around them, and every multi-digit Arabic-Indic number in every
  // document came out backwards — `١٠` delivered as `٠١`, ten as one.
  //
  // The 28-deck corpus could never show this: it writes its numbers in Western
  // digits, which are EN and were always handled. Found by the synthetic
  // ground-truth factory on a Chromium print of an authored string
  // (`experiments/factory`, item `digits-1`), which is what that exists for.
  if (RE_AN.test(ch)) return CLS.AN;
  if (RE_RTL.test(ch)) return CLS.R;
  if (RE_LTR.test(ch)) return CLS.L;
  if (RE_NUM.test(ch)) return CLS.EN;
  return CLS.N;
}

/**
 * Unicode bidi mirroring pairs. A layout engine renders logical "(" inside an
 * RTL run using the mirrored glyph ")". Position is recovered by the reversal
 * below; this table exists for the cases where the glyph itself must be
 * corrected (LTR islands, and validation).
 */
const MIRROR = new Map(Object.entries({
  "(": ")", ")": "(", "[": "]", "]": "[", "{": "}", "}": "{",
  "‹": "›", "›": "‹", "«": "»", "»": "«",
  "<": ">", ">": "<",
}));

export const mirrorOf = (ch) => MIRROR.get(ch) ?? ch;
export const isMirrorable = (ch) => MIRROR.has(ch);

/**
 * Resolve neutral characters (spaces, punctuation, brackets) to the direction
 * of their surroundings: a neutral flanked by the same class joins it,
 * otherwise it takes the paragraph base direction. This mirrors UAX#9 N1/N2
 * closely enough for single-line reconstruction and is fully deterministic.
 */
/**
 * Which visual items are GLUED to the one before them.
 *
 * The producer's own spacing is a token boundary it already committed to.
 * Measured on the formula line: every glyph inside "=SUM(C2:L2)" abuts its
 * neighbour at a 0.00pt gap, while the ":" that precedes the formula sits
 * 6.76pt clear of the "=". That gap is the difference between a character
 * belonging to the island and one merely next to it, and no amount of character
 * classification can see it.
 *
 * Geometry is optional: callers without x positions get "everything attached",
 * which is the behaviour this function replaced.
 */
function attachment(visual) {
  const out = new Array(visual.length).fill(true);
  for (let i = 1; i < visual.length; i++) {
    const a = visual[i - 1], b = visual[i];
    if (a?.x1 == null || b?.x0 == null) continue;
    // A fraction of the type size, not a fixed point value, so it holds at any
    // scale. Intra-token gaps here are 0.00; a real boundary is over half a
    // typical space.
    const size = b.size || a.size || 10;
    out[i] = b.x0 - a.x1 <= size * 0.15;
  }
  return out;
}

/**
 * Mathematical operators, plus the spreadsheet "$". Deliberately excludes
 * brackets (they mirror) and all sentence punctuation (":", ".", ",") — see the
 * note in resolveNeutrals.
 *
 * "$" earns its place on the same ground as "=": it is never Arabic sentence
 * punctuation, and an absolute reference is the spreadsheet convention the
 * source is literally quoting. Without it `اكتب $F$2،` came out `اكتب F$2$` —
 * the marker carried to the far side of the cell address it marks.
 *
 * THE SUPERSCRIPT AND SUBSCRIPT BLOCK earns it for the same reason, and it is
 * the strongest case of the three: `²` cannot begin a word, cannot stand alone,
 * and is only ever the tail of the token it touches. Left neutral at the edge of
 * an island it takes the paragraph's direction and is carried across:
 *
 *   visual  )m²(        got  (²m)        truth  (m²)
 *   visual  ²وحدة        got  ²وحدة        truth  وحدة²
 *
 * U+00B2/B3/B9 sit apart from the rest of their own block, which is why the
 * range needs all three named — the same Latin-1 trap as `×` and `÷`.
 */
const RE_OPERATOR = /[=+\-−×÷<>≤≥±$²³¹\u2070-\u209c]/;

function resolveNeutrals(classes, baseIsRtl, attached, chars) {
  const base = baseIsRtl ? CLS.R : CLS.L;
  const opposite = baseIsRtl ? CLS.L : CLS.R;
  const out = classes.slice();
  const glued = attached ?? new Array(classes.length).fill(true);

  for (let i = 0; i < out.length; i++) {
    if (out[i] !== CLS.N) continue;
    let j = i;
    while (j < out.length && out[j] === CLS.N) j++;
    // UAX#9 N1: numbers influence adjacent neutrals as if they were R.
    const atStart = i === 0, atEnd = j >= out.length;
    const before = atStart ? base : numbersActAsR(out[i - 1]);
    const after = atEnd ? base : numbersActAsR(out[j]);

    let fill = before === after ? before : base;

    // DEVIATION FROM N2, AND IT IS EVIDENCE-DRIVEN. At a LINE EDGE, N2 hands the
    // neutral the paragraph direction, which for "=SUM(C2:L2)" at the left end of
    // an RTL line classes the "=" as R and carries it to the far side of its own
    // formula: measured output ")SUM(C2:L2=" against a source that renders
    // "=SUM(C2:L2)".
    //
    // We are reading VISUAL order, and visual order settles it. Had that "="
    // really been base-R, the renderer would have placed it on the OTHER side of
    // the Latin island — an R character logically preceding an LTR island appears
    // to its RIGHT in RTL flow. Seeing it on the left is proof it was laid out as
    // part of the island. The browser knew because the formula was its own inline
    // element; the PDF kept the result, not the markup.
    //
    // Only at a true edge, and only when the single strong neighbour opposes the
    // base — everything with strong context on both sides still follows N1/N2.
    // And only the part of the run PHYSICALLY GLUED to that neighbour: the run
    // here is ":" + "=", of which only "=" touches the formula. Absorbing the
    // whole run moved the colon to the wrong end of the line instead.
    // WHICH SIDE holds the island. At a line edge the missing neighbour already
    // reads as `base`, so this subsumes the atStart/atEnd form it replaces and
    // adds the INTERIOR case: `صيغة الدالة: =SUMIF(range ; criteria ; sum_range)`
    // puts the formula in the MIDDLE of the line, where the "=" is at neither
    // edge and the edge-only test never fired at all. Measured output:
    // `SUMIF(range ; criteria ; sum_range)=`, the operator carried to the far
    // side of its own formula — the same failure the edge rule exists to stop.
    const islandRight = after === opposite, islandLeft = before === opposite;
    if (before !== after && (islandLeft || islandRight)) {
      // Absorb only OPERATORS, and only ones physically glued to the island.
      //
      // The general form of this rule was measured and rejected: it cost 38
      // verbatim blocks to gain 2. A neutral sitting at the visual edge next to
      // a Latin island is genuinely ambiguous by character class — ")Data(" and
      // ":PLC" have the same shape as "=SUM(C2:L2)" and want the OPPOSITE
      // answer, because their neutral belongs to the Arabic sentence
      // ("(Data)", "PLC:") while the formula's "=" belongs to the formula.
      //
      // What is not ambiguous is a mathematical operator. It is never Arabic
      // sentence punctuation, and a leading "=" is the spreadsheet-formula
      // convention the source is literally quoting. Brackets are excluded on
      // purpose: they mirror, so a ")" at the visual start is a LOGICAL "(" that
      // belongs after the Arabic, and N0 above already pairs the real ones.
      const glue = [];
      if (islandRight) { for (let k = j - 1; k >= i && glued[k + 1]; k--) glue.push(k); }
      else { for (let k = i; k < j && glued[k]; k++) glue.push(k); }

      // The LONGEST run growing OUTWARD from the island that is still nothing but
      // operators and empty bracket pairs — not the whole glued run tested
      // all-or-nothing. All-or-nothing rejects a run whose OUTER end is ordinary
      // punctuation even when its inner end plainly belongs to the island: the
      // absolute reference in `اكتب $F$2،` is reached through "،$", the comma
      // disqualifies the pair, and the "$" is handed to the Arabic — measured
      // output `اكتب F$2$`. Growing outward can never absorb a character the old
      // test would have refused; it stops at the first one instead of discarding
      // everything inside it.
      let absorb = [];
      for (let n = 1; n <= glue.length; n++) {
        const take = glue.slice(0, n);
        let residue = [...take].sort((x, y) => x - y).map((k) => chars[k]).join("");
        for (const pair of ["()", "[]", "{}"]) residue = residue.split(pair).join("");
        if ([...residue].every((c) => RE_OPERATOR.test(c))) absorb = take;
      }

      // An EMPTY bracket pair carries no direction of its own — N0 above says so
      // explicitly and leaves it neutral — so the only evidence it has is the one
      // the operator rule already trusts: it is physically glued to the island.
      // `=STDEV.P()` is the shape, and leaving the pair behind produced
      // `)(=STDEV.P`: the call was split from its own brackets. A pair with
      // anything INSIDE it still fails this test and is left to N0/N1/N2, which
      // is what keeps `(8 دقائق)` out of the island beside it.
      if (absorb.length) {
        for (const k of absorb) out[k] = opposite;
        for (let m = i; m < j; m++) if (!absorb.includes(m)) out[m] = fill;
        i = j - 1;
        continue;
      }
    }

    for (let k = i; k < j; k++) out[k] = fill;
    i = j - 1;
  }
  return out;
}

/**
 * UAX#9 N0 — paired brackets. This implementation never had it.
 *
 * A bracket pair enclosing text of one direction must take that direction as a
 * unit, or the two halves resolve independently and end up on opposite sides of
 * what they enclose. Measured: "=SUM(C2:L2)" inside an Arabic line put the ")"
 * back with the Arabic while "(" stayed with the Latin, giving ")SUM(C2:L2".
 *
 * Simplified for a single run sequence, which is all a reconstructed line is:
 * a pair whose interior holds a strong class takes that class. Inside an LTR
 * island visual order already equals logical order, so pairing the visual stream
 * is sound; brackets in RTL text are mirrored by the producer and are matched by
 * their canonical opening form.
 */
function applyN0(classes, chars) {
  // `typeof`, not `process?.env`: optional chaining does not save an UNDECLARED
  // identifier, and this module is now served to the browser as well.
  if (typeof process !== "undefined" && process.env?.NO_N0) return classes;
  const OPEN = "([{";
  const CLOSE = ")]}";
  const out = classes.slice();
  const stack = [];

  for (let i = 0; i < chars.length; i++) {
    if (out[i] !== CLS.N) continue;
    const ch = chars[i];
    if (OPEN.includes(ch)) { stack.push({ i, want: CLOSE[OPEN.indexOf(ch)] }); continue; }
    if (!CLOSE.includes(ch)) continue;

    const openIdx = stack.map((s) => s.want).lastIndexOf(ch);
    if (openIdx < 0) continue;
    const open = stack[openIdx];
    stack.length = openIdx;                       // discard anything unmatched inside

    let sawL = false, sawR = false;
    for (let k = open.i + 1; k < i; k++) {
      if (out[k] === CLS.L) sawL = true;
      else if (out[k] === CLS.R || out[k] === CLS.AN) sawR = true;
    }
    // A pair holding both directions is genuinely ambiguous — leave it to N1/N2
    // rather than guess. A pair holding neither stays neutral, exactly as N0 says.
    if (sawL && !sawR) { out[open.i] = CLS.L; out[i] = CLS.L; }
    // AND NOT THE MIRROR OF IT. An R interior does NOT hand the pair class R,
    // and the asymmetry is real: the reversal below already carries a bracket
    // across an RTL run by POSITION, so classing it R as well moves it twice.
    // Measured on the bibliography, an LTR line with an Arabic parenthetical:
    // `Wiley. (المرجع التطبيقي للجداول المحورية).` came out `Wiley. )المرجع
    // التطبيقي للجداول المحورية(.` — the pair reversed with the island it
    // encloses instead of staying in the sentence that encloses IT.
    //
    // Left neutral, N1/N2 answer it from the same evidence and get it right in
    // both bases: Arabic on both sides fills R exactly as this branch did, and
    // Latin on one side fills the base, which is the case that was wrong.
  }
  return out;
}

const numbersActAsR = (c) => (c === CLS.EN || c === CLS.AN ? CLS.R : c);

/**
 * European separators (+ - U+2212) and common separators (, . / : NBSP).
 * These bind numbers together; other neutrals such as an EN DASH do not.
 */
const RE_ES = /[+\-−]/;
const RE_CS = /[,.\/: ]/;

/**
 * UAX#9 rule W4: a SINGLE separator between two numbers of the same type joins
 * them into one number.
 *
 * This is what separates two cases that look identical at a glance:
 *   "80/20"  slash is CS  -> one number run, never swaps
 *   "1–3"    en dash is ON -> two runs, and they legitimately swap in RTL
 * Implementing W7 without W4 fixed the second and broke the first.
 */
function applyW4(classes, chars) {
  const out = classes.slice();
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] !== CLS.N) continue;
    const prev = out[i - 1], next = out[i + 1];
    const ch = chars[i];
    if (prev === CLS.EN && next === CLS.EN && (RE_ES.test(ch) || RE_CS.test(ch))) out[i] = CLS.EN;
    else if (prev === CLS.AN && next === CLS.AN && RE_CS.test(ch)) out[i] = CLS.AN;
  }
  return out;
}

/**
 * UAX#9 rule W7, applied in visual order.
 *
 * A number takes the direction of the last strong character before it: after
 * Latin it becomes part of that Latin run, after Arabic it stays a number.
 * That single distinction decides two cases that otherwise conflict:
 *
 *   "(Microsoft Excel 365)"  the 365 follows Latin -> joins the Latin island,
 *                            so the whole phrase reverses as one unit.
 *   "(1–3)"                  the digits follow Arabic -> stay numbers, and the
 *                            dash between them resolves to RTL (N1 above), so
 *                            they are two islands that swap back correctly.
 *
 * Without W7 both were forced into one island and "1–3" came out "3–1".
 * Scanning leftward in visual order is the correct direction here: inside an
 * LTR island visual order already matches logical order.
 */
function applyW7(classes, baseIsRtl) {
  const out = classes.slice();
  let lastStrong = baseIsRtl ? CLS.R : CLS.L;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === CLS.L || out[i] === CLS.R) lastStrong = out[i];
    else if ((out[i] === CLS.EN || out[i] === CLS.AN) && lastStrong === CLS.L) out[i] = CLS.L;
  }
  return out;
}

/** Classes that form a left-to-right island inside RTL text. */
const isLtrRun = (c) => c === CLS.L || c === CLS.EN || c === CLS.AN;

/**
 * Convert a VISUALLY ordered item list into logical order.
 *
 * Each item must expose `.c` (the character). Items are returned re-ordered;
 * mirrored bracket glyphs inside the reversal are corrected in place via a
 * shallow copy so the caller's originals are never mutated.
 *
 * @param {{c:string, groupId?:number}[]} visual  left-to-right page order
 * @param {boolean} baseIsRtl  paragraph base direction
 */
export function visualToLogical(visual, baseIsRtl = true) {
  if (visual.length <= 1) return visual.slice();

  const chars = visual.map((g) => g.c);
  // W4 -> W7 -> N0 -> N1/N2, the UAX#9 order. N0 must run before the neutral
  // sweep or the two halves of a pair are resolved independently.
  const classes = resolveNeutrals(
    applyN0(applyW7(applyW4(chars.map(classify), chars), baseIsRtl), chars),
    baseIsRtl,
    attachment(visual),
    chars
  );

  // Ligature components (two chars emitted at one origin, e.g. lam-alef) are
  // already in logical order relative to each other and must survive reversal
  // as an atomic unit. Group them before reordering.
  const units = [];
  for (let i = 0; i < visual.length; i++) {
    const g = visual[i];
    const prev = units[units.length - 1];
    if (prev && g.groupId != null && g.groupId === prev.items[0].groupId) {
      prev.items.push(g);
    } else {
      units.push({ items: [g], cls: classes[i] });
    }
  }

  // DO NOT ADD L4 MIRRORING HERE. Tried and rejected 2026-08-15: un-mirroring
  // every bracket in an R-classed unit DOES fix "=SUMIF(الوردية;"ص";الكمية)",
  // and it costs 275 verbatim blocks — 86.47% -> 75.26% across the corpus. The
  // reversal already recovers bracket POSITION for the ordinary cases, so
  // flipping the glyph as well double-corrects them. The comment on MIRROR above
  // is right: that table is for LTR islands and validation, not for a sweep.

  if (!baseIsRtl) {
    // Base is LTR: visual order IS logical order for the LTR text, but every
    // contiguous RTL island still runs the other way and must be reversed —
    // the exact mirror of what the RTL branch below does for LTR islands.
    //
    // Returning the units untouched here was wrong and silently so: measured on
    // "8 × 60 = 480 دقيقة", an LTR formula carrying an Arabic unit word, it gave
    // "8 × 60 = 480 ةقيقد". Nothing in the corpus exercised it because every
    // block was classed RTL, which is also why an earlier attempt to switch
    // these blocks to LTR fixed nothing and broke eleven.
    for (let i = 0; i < units.length; i++) {
      if (units[i].cls !== CLS.R) continue;
      let j = i;
      while (j + 1 < units.length && units[j + 1].cls === CLS.R) j++;
      for (let a = i, b = j; a < b; a++, b--) [units[a], units[b]] = [units[b], units[a]];
      i = j;
    }
    return units.flatMap((u) => u.items);
  }

  // Base is RTL: the whole visual line reverses...
  units.reverse();

  // ...and every contiguous LTR island reverses back.
  //
  // THE ISLAND IS A LEVEL, NOT A CLASS. In an RTL paragraph UAX#9 I2 raises L,
  // EN and AN all to level 2, so adjacent units of those three classes are ONE
  // level-2 run and L2 reverses them together. Requiring the whole island to
  // share one class split it wherever the two met, and the split unit landed on
  // the wrong side of the line reversal:
  //
  //   visual   "ةعاس 2X1+X2≤40 :ةراجنلا ديق"
  //   was      "قيد النجارة: X1+X2≤402 ساعة"   <- the leading 2 emitted last
  //   is       "قيد النجارة: 2X1+X2≤40 ساعة"
  //
  // The leading digit of a formula is EN and not L because W7 looks LEFTWARD in
  // visual order and finds Arabic, which is correct; it is the ISLAND rule that
  // was wrong. Two number runs genuinely separated by a direction change are
  // unaffected — "(1–3)" keeps its dash resolved to R by N1, so its two EN units
  // are not adjacent and do not merge here.
  for (let i = 0; i < units.length; i++) {
    if (!isLtrRun(units[i].cls)) continue;
    let j = i;
    while (j + 1 < units.length && isLtrRun(units[j + 1].cls)) j++;
    for (let a = i, b = j; a < b; a++, b--) [units[a], units[b]] = [units[b], units[a]];
    i = j;
  }

  return units.flatMap((u) => u.items);
}

/* -------------------------------------------------------------------------- */
/* Base direction of one line                                                  */
/* -------------------------------------------------------------------------- */

// Escaped, not literal: these ranges are invisible or RTL, and an editor
// reordering them silently turns "harakat" into "harakat plus the Arabic-Indic
// digits". U+064B-065F harakat/tanween/shadda, U+0670 superscript alef,
// U+06D6-06ED Quranic marks.
/** Arabic combining marks: harakat, tanween, shadda, sukun, superscript alef. */
export const isCombiningMark = (ch) => /[\u064B-\u065F\u0670\u06D6-\u06ED]/.test(ch);

/** Arabic + Arabic Supplement, and the two classes the direction test weighs. */
const RE_ARABIC = /[\u0600-\u06FF\u0750-\u077F]/;
const RE_LATIN_OR_DIGIT = /[A-Za-z0-9]/;
/**
 * A relation between two numbers — the signature of an arithmetic expression.
 * Thousands separators and decimals are part of a number, not a relation.
 */
const RE_ARITHMETIC = /[\d)]\s*[=×÷+−≤≥<>]\s*[\d(]/;

/**
 * Base direction of one line of text.
 *
 * Lives here rather than beside the extractor because two very different
 * callers need the same answer: the extractor decides it from the visual glyph
 * stream before any text exists, and the PPTX forensics decide it from the
 * logical text in the finished XML to know which paragraphs must carry
 * rtl="1". Two implementations of "is this line Arabic-directional" would drift,
 * and the day they drift the gate either passes a broken deck or fails a good
 * one.
 */
export function textIsRtl(text) {
  // Count WORDS, not characters: a character count is skewed by one long Latin
  // term, so "القيم (Values)" (5 Arabic characters, 6 Latin) reads as Latin when
  // it is plainly an Arabic line.
  let arabicWords = 0, latinWords = 0, kind = null;
  for (const ch of text) {
    if (isCombiningMark(ch)) continue;
    if (/\s/.test(ch)) { kind = null; continue; }
    const isArabic = RE_ARABIC.test(ch);
    const isLatin = RE_LATIN_OR_DIGIT.test(ch);
    if (!isArabic && !isLatin) continue;        // neutrals take the run they touch
    const k = isArabic ? "a" : "l";
    if (k !== kind) { if (k === "a") arabicWords++; else latinWords++; kind = k; }
  }

  // Some lines say which way they run, and word counts cannot hear it. A
  // reference list is the case that matters here: its entries are laid out
  // left-to-right even in an Arabic deck, and the ones carrying an Arabic gloss
  // came out reversed around their own citation. Measured: 35 fixed, 0 broken.
  // The mirror of the rule below, and it must be asked first because a fragment
  // that is nothing but a closing bracket satisfies both.
  if (!arabicWords && opensWithLoneCloser(text)) return true;

  if (readsLeftToRight(text, arabicWords, latinWords)) return false;

  // No Arabic at all: the line is LTR unless the RENDERER SAYS OTHERWISE. A
  // bracket pair drawn closing-first is UAX#9 L4 plus the RTL reversal caught in
  // the act — "(Ergonomics)" inside an Arabic paragraph is painted ")Ergonomics("
  // — and a lone Latin term on its own line has no other evidence to offer.
  // Measured over 28 decks: 12 blocks fixed, 0 broken.
  if (!arabicWords) return hasMirroredPair(text);

  if (arabicWords > latinWords) return true;    // unambiguously an Arabic line

  // A tie or a Latin-heavy line is ambiguous from word counts alone, and the two
  // classes pull opposite ways:
  //     "8 × 60 = 480 دقيقة"      an LTR formula carrying an Arabic unit word
  //     "3. معرفة (Knowledge)"     an Arabic line quoting a Latin term
  //     "شريحة 10 من 19"           an Arabic footer carrying numbers
  //
  // What separates the first from the rest is that it is ARITHMETIC: a relation
  // between two numbers. A mathematical expression is laid out left-to-right
  // whatever language surrounds it, so that is a real typographic fact rather
  // than a heuristic about this corpus. The others merely contain digits.
  //
  // Page geometry was tried instead and is confounded: the footer sits at the
  // left margin without being left-aligned text, which flipped 81 footers.
  //
  // And the exemption only holds while the Arabic really is a UNIT hanging off
  // the expression. "الخطوة 2 — زمن الطلَب: Ttakt = 25200 ÷ 900 = 28 ثانية/وحدة"
  // is an Arabic SENTENCE that quotes a formula, and calling it LTR reversed the
  // sentence around the formula. Both shapes hold a relation between two
  // numbers, so RE_ARITHMETIC alone cannot separate them; what does is that a
  // unit label is one contiguous group of Arabic with no Latin or digits on one
  // side of it. Measured: 34 blocks fixed, 0 broken.
  return !(RE_ARITHMETIC.test(text) && arabicIsEdgeLabel(text));
}

/**
 * Marks whose POSITION is decided by the line's direction. Both are read off the
 * left/right EDGE, which is the only place direction is legible without already
 * knowing it:
 *
 *   "[4] Shingo, S. (1985). ... (منهجية تقليص زمن"
 *        a numbered reference marker at the START. Its logical place is the
 *        beginning of the entry, so finding it there means the entry runs left
 *        to right — the Arabic-language entry in the very same list carries its
 *        "[8]" at the other end. Latin dominance is required as well: an Arabic
 *        sentence ending in a footnote marker has the same edge shape and wants
 *        the opposite answer.
 *
 *   "الأنظمة الإنتاجية)."
 *        a closing bracket at the END with no opener anywhere in the line. The
 *        pair opened on the previous line, so the text is flowing into this one
 *        from the left. Reversed, this fragment reads ".)الأنظمة".
 */
function readsLeftToRight(text, arabicWords, latinWords) {
  if (/^\s*\[\d+\]/.test(text) && latinWords > arabicWords) return true;
  if (arabicGlossInLatinLine(text)) return true;
  return /[)\]]\s*[.،؛]?\s*$/.test(text) && !/[([]/.test(text);
}

/**
 * A reference-list entry whose Arabic gloss is parenthesised:
 *
 *   painted   140. (ةيلمعلا–جتنملا ةفوفصمل يلصلأا عجرملا).
 *   was       .)المرجع الأصلي لمصفوفة المنتج–العملية( .140
 *   is now    140. (المرجع الأصلي لمصفوفة المنتج–العملية).
 *
 * The `[4]` rule above catches the entries that carry a numbered marker. These
 * carry none, and word counts answer confidently and wrongly: six Arabic words
 * against one Latin one says "Arabic line", so the whole entry is reversed
 * around its own citation and the brackets mirror with it.
 *
 * The evidence is the BRACKET ORDER, not the word counts. A bracket pair
 * enclosing Arabic inside an RTL line is painted CLOSING-first — that is exactly
 * what `hasMirroredPair` below detects, and it is a fact about how the source's
 * own engine lays out an island, not a heuristic about this corpus. Painted
 * opening-first, with the Arabic confined to the brackets and Latin or digits
 * outside them, the line is running left to right.
 *
 * Three gates, each of which was measured and each of which is load-bearing:
 *
 *   opening-first        allowing either order costs 2 blocks
 *   no Latin INSIDE      allowing it gains 3 and costs 2
 *   the line ENDS on the bracket, so a mid-sentence parenthetical (an Arabic
 *   sentence quoting a Latin term) can never match
 *
 * MEASURED over 28 decks: 21 blocks match, 17 fixed, 0 broken. The predicate
 * gives the same answer on the visual glyph string and on the finished logical
 * text, which it must: `textIsRtl` is shared with the PPTX forensics, and the
 * day the two disagree the gate passes a broken deck or fails a good one.
 *
 * CORRECTION, 2026-08-20: that last paragraph is an ASPIRATION, not a fact, and
 * it is false for the lone-closer clause of `readsLeftToRight` above — reversing
 * a string moves a trailing closer to the front, so `وقياس الأزمنة).` is called
 * LTR here and RTL on the visual stream it came from. It is false for this
 * predicate too whenever the line carries Latin OUTSIDE the brackets, because
 * the visual stream paints the pair closing-first and the scan for `(` then `)`
 * finds nothing. Measured at the artifact: 59 paragraphs over 30 decks where the
 * two callers disagree, and in all 59 the EXTRACTOR is right.
 *
 * That is not a bug to fix here. This function answers "which base direction
 * reconstructs this painted line", and it is asked that question by the
 * extractor with the painted line in hand. The forensics must not ask it "which
 * direction should this finished paragraph be declared", which is a different
 * question — `src/pptx/inspect.js` answers that one from the presence of Arabic,
 * a fact no reordering can change. See KNOWN_ISSUES 2026-08-20.
 */
function arabicGlossInLatinLine(text) {
  if (!/[)\]]\s*[.،؛]?\s*$/.test(text)) return false;
  for (let i = text.indexOf("("); i >= 0; i = text.indexOf("(", i + 1)) {
    const j = text.indexOf(")", i + 1);
    if (j < 0) break;
    const inside = text.slice(i + 1, j);
    const outside = text.slice(0, i) + text.slice(j + 1);
    if (!RE_ARABIC.test(inside) || /[A-Za-z]/.test(inside)) continue;
    if (RE_LATIN_OR_DIGIT.test(outside) && !RE_ARABIC.test(outside)) return true;
  }
  return false;
}

/**
 * Every Arabic character in one contiguous group, with nothing but decoration
 * (an arrow, a "✓") on one side of it — the shape of "480 ÷ 8 = 60 وحدة", where
 * the Arabic names the unit of the result rather than saying anything.
 */
function arabicIsEdgeLabel(text) {
  const at = [...text].map((c, i) => (RE_ARABIC.test(c) ? i : -1)).filter((i) => i >= 0);
  if (!at.length) return true;
  const span = text.slice(at[0], at[at.length - 1] + 1);
  if (RE_LATIN_OR_DIGIT.test(span)) return false;          // Arabic on both sides of the expression
  return !RE_LATIN_OR_DIGIT.test(text.slice(0, at[0])) ||
         !RE_LATIN_OR_DIGIT.test(text.slice(at[at.length - 1] + 1));
}

/**
 * A block that OPENS with a closing bracket and never opens one:
 *
 *   painted  )Occupancy Grid          the pair opened on the line above
 *   was      )Occupancy Grid
 *   is now   Occupancy Grid)
 *
 * This is the exact mirror of `readsLeftToRight`'s second clause, which reads a
 * lone closer at the END of a line as proof the text is flowing in from the
 * left. Found at the START, painted before its own content, it is proof of the
 * opposite: an RTL paragraph paints the tail fragment `Occupancy Grid)` with the
 * bracket on the left.
 *
 * `hasMirroredPair` deliberately refuses a lone bracket, on the grounds that one
 * is "far more often a block boundary landing mid-phrase than proof of
 * anything". That is right, and it is precisely why this fragment is RTL — the
 * block boundary is the whole point. Requiring NO Arabic keeps it to the case
 * with no other evidence to weigh; requiring no opener keeps it to a genuine
 * fragment rather than a complete parenthetical.
 *
 * MEASURED over 28 decks: 12 blocks match, 12 fixed, 0 broken.
 */
function opensWithLoneCloser(text) {
  return /^\s*[)\]]/.test(text) && !/[([]/.test(text);
}

/**
 * Does a bracket pair appear closing-form first? That ordering cannot be
 * authored — it is what an RTL line does to a bracketed island on the way out.
 * Only a pair counts: a lone ")" is far more often a block boundary landing
 * mid-phrase than proof of anything.
 */
function hasMirroredPair(text) {
  return [[")", "("], ["]", "["], ["}", "{"], ["»", "«"], ["›", "‹"]].some(([close, open]) => {
    const c = text.indexOf(close);
    const o = text.indexOf(open);
    return c >= 0 && (o < 0 || o > c) && text.indexOf(open, c + 1) > c;
  });
}

/** Convenience: logical string from visually ordered items. */
export const toLogicalString = (visual, baseIsRtl = true) =>
  visualToLogical(visual, baseIsRtl).map((g) => g.c).join("");
