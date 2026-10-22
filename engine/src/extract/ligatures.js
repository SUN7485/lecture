/**
 * Recover characters that structured text loses at a lam-alef ligature.
 *
 * THE DEFECT (measured, Chp1-Lec1-3(New).pdf p2, both paths in page space):
 *
 *   x        structured text          device path
 *   479.31   "ا" U+0627  w 0.00       "ﺎ" U+FE8E  adv 0.306   <- a real alef
 *   470.81   "ل" U+0644  ONE char     "ﻻ" U+FEFB  adv 0.630   <- TWO characters
 *
 * A lam-alef ligature is one painted glyph standing for two characters. Usually
 * structured text decomposes it itself (~97.8% of 1,111 in this corpus). It
 * fails when a separate real glyph starts at the ligature's tail position: the
 * two collide and stext emits ONE character where TWO belong. Three characters
 * are due here ("ا" + "ل" + "ا"), two arrive, and "الريالات" becomes "الريلات".
 *
 * WHY THIS IS COUNT-GATED. Three earlier repairs regressed the corpus (63.28%,
 * 80.68%, 60.80% against 81.09%) because they matched the two paths by hashing
 * positions — which cannot work when the defect IS two glyphs sharing a
 * position. So nothing here is decided by position alone:
 *
 *   1. Per baseline, compare characters OWED by the device (2 for a lam-alef
 *      ligature, 1 otherwise) against characters SUPPLIED by stext.
 *   2. A baseline that is not short is left completely untouched.
 *   3. Only on a short baseline is an individual ligature examined, and only one
 *      that is itself under-supplied is repaired.
 *
 * That makes the common case a no-op by construction rather than by guard, which
 * is what the earlier attempts got wrong.
 *
 * See KNOWN_ISSUES.md "Dropped alef" and docs/SOLUTIONS.md P1 for the full
 * measurement trail, including the three approaches that must not be retried.
 */
import * as mupdf from "mupdf";
import { detachBorrowed, release } from "./mupdf-lifetime.js";
import { isCombiningMark } from "./bidi.js";

/** The eight Arabic presentation forms standing for two base characters. */
export const LAM_ALEF_LIGATURES = new Map([
  [0xfef5, ["ل", "آ"]], [0xfef6, ["ل", "آ"]],  // lam + alef madda
  [0xfef7, ["ل", "أ"]], [0xfef8, ["ل", "أ"]],  // lam + alef hamza above
  [0xfef9, ["ل", "إ"]], [0xfefa, ["ل", "إ"]],  // lam + alef hamza below
  [0xfefb, ["ل", "ا"]], [0xfefc, ["ل", "ا"]],  // lam + alef
]);

/**
 * Alef presentation forms that stand for exactly one character: plain alef.
 * Excludes the lam-alef ligatures above, which owe two and are handled there.
 */
const ALEF_FORMS = new Map([
  [0xfe8d, "ا"], [0xfe8e, "ا"],   // alef, isolated / final
  [0xfe81, "آ"], [0xfe82, "آ"],   // alef madda
  [0xfe83, "أ"], [0xfe84, "أ"],   // alef hamza above
  [0xfe87, "إ"], [0xfe88, "إ"],   // alef hamza below
]);

/** Fathatan/dammatan/kasratan — the tanween marks that sit on a final alef. */
const TANWEEN = new Set(["ً", "ٌ", "ٍ"]);

/**
 * Every Arabic presentation form that stands for more than one LETTER, and the
 * letters it stands for — derived from Unicode's own NFKD decomposition rather
 * than typed out, because the hardcoded lam-alef map above covers 8 of them and
 * the corpus uses more. Measured: `Chp3-Lec19` loses its final yeh to U+FC87
 * "ﲇ", a lam-yeh ligature the map never mentioned.
 *
 * Only LETTERS count. NFKD also decomposes forms that are one character with a
 * mark on it — "ﺁ" U+FE81 gives alef + madda-above, and "ﹰ" U+FE70 gives space +
 * fathatan — and treating those as two characters would make every one of them
 * look under-supplied and invite a repair that duplicates them.
 */
const ARABIC_LETTER = /[ء-غف-يٮ-ۓ]/;
const LIGATURE_PARTS = (() => {
  const map = new Map();
  for (const [lo, hi] of [[0xfb50, 0xfdff], [0xfe70, 0xfeff]]) {
    for (let cp = lo; cp <= hi; cp++) {
      // Marks are KEPT and recomposed onto the letter they belong to, never
      // filtered away. NFKD is a full decomposition, so "ﻷ" U+FEF7 comes back as
      // lam + alef + hamza-above and a letter filter reports its parts as
      // ["ل","ا"] — the right count and the wrong second letter. That is not
      // cosmetic: `proposeLigatures` inserts `parts[1]` verbatim, so every
      // hamza-carrying lam-alef it repaired put back a bare alef; and the
      // device-witnessed grouping pass in glyphs.js matches stext's character
      // against this name, so at `للأسبوع` it compared `أ` with `ا`, found
      // nothing, and left the ligature ungrouped on 25 of the 28 decks.
      const clusters = [];
      for (const c of String.fromCodePoint(cp).normalize("NFKD")) {
        if (ARABIC_LETTER.test(c)) clusters.push(c);
        else if (clusters.length && /\p{Mn}/u.test(c)) clusters[clusters.length - 1] += c;
      }
      const parts = clusters.map((c) => c.normalize("NFC"));
      if (parts.length > 1) map.set(cp, parts);
    }
  }
  return map;
})();

/**
 * Every presentation form standing for exactly ONE Arabic letter, and the letter
 * it is. 239 of them, derived from Unicode rather than typed out — the same
 * reasoning as `LIGATURE_PARTS` above, and the reason `ALEF_FORMS` covering eight
 * of them was never the boundary of the defect.
 *
 * NFKC, not NFKD, and that is load-bearing: NFKD fully decomposes, so "ﺁ" U+FE81
 * comes back as alef + madda-above and the madda is silently dropped by a letter
 * filter. NFKC gives the composed letter U+0622 "آ", which is the character the
 * page actually painted.
 *
 * Forms that decompose to more than one letter are excluded — those are ligatures
 * and they owe two characters, which is `LIGATURE_PARTS`' business.
 */
const SINGLE_LETTER_FORMS = (() => {
  const map = new Map();
  for (const [lo, hi] of [[0xfb50, 0xfdff], [0xfe70, 0xfeff]]) {
    for (let cp = lo; cp <= hi; cp++) {
      const s = String.fromCodePoint(cp);
      if ([...s.normalize("NFKD")].filter((c) => ARABIC_LETTER.test(c)).length !== 1) continue;
      const composed = s.normalize("NFKC");
      if ([...composed].length !== 1 || !ARABIC_LETTER.test(composed)) continue;
      map.set(cp, composed);
    }
  }
  return map;
})();

/** How many characters this painted glyph is answerable for. */
export const owedOf = (unicode) => LIGATURE_PARTS.get(unicode)?.length ?? 1;

/**
 * How strong a proposal's evidence is. LOWER WINS, and the order is an argument.
 *
 * `PAINTED_GLYPH` outranks the rest because it is a positive OBSERVATION: the
 * device painted a separate glyph, with its own real advance, at that position.
 * The other two are counting INFERENCES — a glyph owes two characters and one
 * arrived — which is weaker evidence about what belongs there, however sound the
 * arithmetic. Measured on `توقف الاستراحة`, where both fire: the painted-glyph
 * proposal inserts a full-width alef that stays out of the ligature's group and
 * reads `الاستراحة`, while the counting proposal inserts a zero-width one that
 * groups with the lam. Only one of those is the word.
 *
 * A named form beats a bare count for the same reason one step down: `NAMED_FORM`
 * knows the alef it is putting back is an alef because Unicode says so about that
 * presentation form, where `INFERRED_FROM_COUNT` knows only that something is
 * missing and takes the components on trust.
 */
const RANK = {
  PAINTED_GLYPH: 0,
  NAMED_FORM: 1,
  INFERRED_FROM_COUNT: 2,
};

/** Two reports describe the same glyph within this distance (pt). */
const SAME_POS = 0.6;
/** Glyphs within this vertical distance (pt) share a baseline. */
const SAME_BASELINE = 0.6;
/** A quad narrower than this carries no advance. */
const ZERO_W = 0.5;

/**
 * Every glyph the page paints, with its true identity and advance.
 *
 * COORDINATES: `showGlyph`'s `trm` is in content-stream space. The `ctm` handed
 * to `fillText` MUST be concatenated or positions land in a different space
 * entirely (4/3 scale on this corpus) and every lookup silently misses. Two
 * earlier probes failed exactly this way; `src/extract/vectors.js` gets it right.
 *
 * Only `fillText` is observed. Text painted as clip or stroke is not reported,
 * which is safe here: a baseline with no device evidence is simply left alone.
 */
export function deviceGlyphs(page, arity) {
  const out = [];

  const device = new mupdf.Device({
    fillText(text, ctm) {
      try {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          const x = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4];
          const y = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5];
          // Effective em size in page units, so the font's em-based advance is
          // comparable with structured-text quad widths.
          const sx = ctm[0] * trm[0] + ctm[2] * trm[1];
          const sy = ctm[1] * trm[0] + ctm[3] * trm[1];
          const em = Math.hypot(sx, sy);
          // What this glyph is ANSWERABLE for. `owedOf` recognises exactly one
          // family — the lam-alef presentation forms — so every other ligature
          // owed 1 and the deficit count balanced on a line that had lost a
          // letter. The font itself knows better: its CFF charset names glyph
          // 612 `lam_yehar.fina.rlig`, and 422 more like it. See cff-names.js.
          // By name, then by the SUBSET TAG. The descriptor and the font program
          // disagree about the name for two faces in this corpus — see the note
          // in cff-names.js — and a lookup that only asks one of them silently
          // hands back "owes 1" for every ligature in that font.
          const fontName = font.getName();
          const named = arity?.get(fontName)?.get(glyph) ??
            arity?.get((fontName.match(/^([A-Z]{6})\+/) ?? [])[1])?.get(glyph);
          // The name gives the COMPONENTS, not just how many, so a repair can
          // state what it inserts instead of guessing it.
          const parts = named?.parts ?? LIGATURE_PARTS.get(unicode) ?? null;
          out.push({
            x, y,
            unicode,
            glyph,
            advance: font.advanceGlyph(glyph) * em,
            owed: named?.owed ?? owedOf(unicode),
            parts,
            fromFont: named != null,
          });
        },
      });
      } finally { release(text); }
    },
    // Every one of these is ignored, and every one is still handed freshly
    // allocated WASM wrappers that only the garbage collector would free. Naming
    // the arguments so they can be released is the whole reason these stubs are
    // not empty — see src/extract/mupdf-lifetime.js.
    fillPath(path) { release(path); },
    strokePath(path, stroke) { release(path, stroke); },
    clipPath(path) { release(path); },
    clipStrokePath(path, stroke) { release(path, stroke); },
    strokeText(text, stroke) { release(text, stroke); },
    clipText(text) { release(text); },
    clipStrokeText(text, stroke) { release(text, stroke); },
    ignoreText(text) { release(text); },
    fillShade(shade) { detachBorrowed(shade); },
    fillImage(image) { release(image); },
    fillImageMask(image) { release(image); },
    clipImageMask(image) { release(image); },
    popClip() {}, beginMask() {}, endMask() {}, beginGroup() {}, endGroup() {},
    beginTile() { return 0; }, endTile() {}, close() {}, drop() {},
  });

  try {
    page.run(device, mupdf.Matrix.identity);
    device.close();
  } finally {
    release(device);
  }
  return out;
}

/** Bucket records onto shared baselines, keyed to a tenth of a point. */
function byBaseline(items) {
  const rows = new Map();
  for (const it of items) {
    const key = Math.round(it.y * 10);
    let row = rows.get(key);
    if (!row) {
      // Tolerate a baseline landing either side of a rounding boundary.
      for (let d = -Math.round(SAME_BASELINE * 10); d <= Math.round(SAME_BASELINE * 10); d++) {
        if (rows.has(key + d)) { row = rows.get(key + d); break; }
      }
    }
    if (row) row.push(it);
    else rows.set(key, [it]);
  }
  return rows;
}

/**
 * PROPOSE the characters stext dropped at a ligature, and only those.
 *
 * A producer, not a repair: it reads the stream and returns proposals, never
 * mutating anything and never spending the budget. `resolveProposals` decides.
 * That split is what makes the output independent of the order the producers run
 * in — see the header of resolve.js for the measurement.
 *
 * @param {object[]} glyphs  structured-text glyphs, in emission order
 * @param {object[]} devs    from `deviceGlyphs(page)`
 * @param {object} budget    from `attributePage`, read-only here
 * @returns {object[]} proposals
 */
export function proposeLigatures(glyphs, devs, budget) {
  if (!devs.length || !glyphs.length) return [];

  const devRows = byBaseline(devs);
  const stRows = byBaseline(glyphs);
  const proposals = [];

  for (const [key, devRow] of devRows) {
    // Find the structured-text row for this baseline.
    let stRow = stRows.get(key);
    if (!stRow) {
      for (let d = -Math.round(SAME_BASELINE * 10); d <= Math.round(SAME_BASELINE * 10) && !stRow; d++) {
        stRow = stRows.get(key + d);
      }
    }
    if (!stRow) continue;

    // Every ligature whose components are NAMED — by the font's CFF charset
    // (`lam_yehar.fina.rlig` and 886 more) or by Unicode's decomposition. Naming
    // is the licence: `parts` is null whenever any component is not a letter this
    // project can name, and a glyph that cannot say what it stands for is counted
    // but never repaired.
    //
    // This was written, measured at +71/-1 and left switched OFF for a session,
    // because the failures could not be told apart from the successes by any gate
    // at this level. They were never misfires: both were the per-baseline budget
    // spending a character missing from ANOTHER WORD. Priced per word, the same
    // producer scores +133 / 0 broken.
    const ligatures = devRow.filter((d) => d.parts?.length >= 2);
    if (!ligatures.length) continue;

    for (const lig of ligatures) {
      // GATE 1: is the ligature's own WORD short? Almost never — and when it is
      // not, nothing below runs, so the common case stays a no-op by
      // construction. This used to ask the question of the whole BASELINE, which
      // is both too coarse and, where structured text puts a mark-carrying base
      // on its mark's line, simply wrong: `بُني` -> `بُيني` was this gate spending
      // an alef missing from `شراء`, two words away. See attribute.js.
      if (budget.deficitOf(lig) <= 0) continue;

      // The ligature's second character belongs at the far end of its advance.
      const tailX = lig.x + lig.advance;
      const atTail = (arr) => arr.filter((g) => Math.abs(g.x - tailX) < SAME_POS);
      const devAtTail = atTail(devRow).length;
      const stAtTail = atTail(stRow);

      // GATE 2: this particular tail must itself be under-supplied — one
      // character for each real glyph there, plus one for the ligature's alef.
      if (stAtTail.length >= devAtTail + 1) continue;

      // The component structured text DID supply, at the ligature's own origin.
      // Only the two-component case is repaired: the corpus has no three-part
      // ligature that also loses a character, and inventing a position for a
      // middle component would be a guess rather than a reading of the evidence.
      const parts = lig.parts;
      if (parts.length !== 2) continue;
      const [lamCh, alefCh] = parts;
      const lam = stRow.find((g) => Math.abs(g.x - lig.x) < SAME_POS && g.c === lamCh);
      if (!lam) continue;

      // A real glyph sharing the tail position arrives from stext with a zero
      // width. Left that way, the zero-width rule in groupAtomicUnits swallows
      // it into the ligature unit and freezes its order ("لاات" for "الات"), so
      // give it back the advance the device reports. Scoped to this site only —
      // doing it globally regressed the corpus to 60.80%.
      //
      // Deferred, because it MUTATES a glyph that already exists. If this
      // proposal loses to a stronger one the mutation must not happen either, or
      // a rejected proposal still leaves its fingerprints on the stream and the
      // result depends on who proposed, not on who won.
      const restores = [];
      for (const g of stAtTail) {
        if (g.x1 - g.x0 >= ZERO_W) continue;
        const real = devRow.find((d) => Math.abs(d.x - g.x) < SAME_POS && d.advance >= ZERO_W);
        if (!real) continue;
        restores.push({ g, x1: g.x0 + real.advance });
      }

      proposals.push({
        producer: "ligature",
        rank: RANK.INFERRED_FROM_COUNT,
        funded: true,
        dev: lig,
        anchor: lam,
        slotX: tailX,
        slotY: lig.y,
        // Emitted immediately after its lam, zero width, at the lam's right edge:
        // exactly the shape stext itself uses when it decomposes a ligature, so
        // the existing grouping rule binds the pair and visualToLogical preserves
        // lam-then-alef order without a second code path.
        glyph: {
          ...lam,
          c: alefCh,
          recovered: true,       // declared, never silent
          recoveredBy: "ligature",
          x: tailX, x0: tailX, x1: tailX,
          paintSeq: lam.paintSeq + 0.5,
        },
        effects: () => {
          for (const r of restores) { r.g.x1 = r.x1; r.g.advanceRestored = true; }
        },
      });
    }
  }

  return proposals;
}

/**
 * Restore a standalone alef that COLLIDED with a lam-alef ligature's tail.
 *
 * MEASURED, Chp4-Lec23-1 p7, truth "الاستغلال", got "الستغلال":
 *
 *   device    x 475.96  U+0627 "ا"   adv 1.97    <- a real, separate alef
 *             x 471.52  U+FFFD       adv 4.44    <- the lam-alef ligature
 *   stext     x 475.96  "ا"  w 0.00              <- the LIGATURE'S TAIL
 *             x 471.52  "ل"  w 4.44
 *
 * Three characters are due, two arrive. The ligature's tail lands exactly where
 * the separate alef begins, and structured text emits one character for both.
 *
 * WHY THIS IS NOT `repairLigatures`. That one counts characters the device OWES
 * against what stext supplied, and reads "owes 2" off the ligature's unicode.
 * Half this corpus is subset-encoded with no usable cmap — the ligature above
 * comes back U+FFFD, worth 1, so the line reports a SURPLUS of 6 characters
 * while visibly missing one and every gate there stays shut. The evidence that
 * survives a missing cmap is the ADVANCE: the device draws an alef 1.97pt wide
 * at a position where structured text put an alef 0.00pt wide.
 *
 * Gates, ordered so the common case is a no-op by construction:
 *   1. the device glyph is an alef form carrying a real advance
 *   2. structured text has that same alef at that position with NO advance
 *   3. it is a LIGATURE TAIL — a lam ends exactly there — and not a mark-carrying
 *      base, which stext also reports as zero width, nor an alef a previous
 *      repair already inserted
 *   4. no second alef with a real advance is already sitting there
 */
export function proposeCollidedAlef(glyphs, devs, budget) {
  if (!devs.length || !glyphs.length) return [];

  const devRows = byBaseline(devs);
  const stRows = byBaseline(glyphs);
  const proposals = [];
  const claimed = new Set();

  for (const [key, devRow] of devRows) {
    let stRow = stRows.get(key);
    if (!stRow) {
      for (let d = -Math.round(SAME_BASELINE * 10); d <= Math.round(SAME_BASELINE * 10) && !stRow; d++) {
        stRow = stRows.get(key + d);
      }
    }
    if (!stRow) continue;

    for (const dev of devRow) {
      // GATE 1.
      const ch = ALEF_FORMS.get(dev.unicode) ?? (dev.unicode === 0x0627 ? "ا" : null);
      if (!ch || dev.advance < ZERO_W) continue;

      // NOT GATED ON THE BUDGET, deliberately, and this was measured the hard
      // way. Requiring a word deficit here cost 5 delivered blocks —
      // `الاستراتيجية` came out `الستراتيجية` on four decks — because the count
      // evidence is precisely what is missing at this site: half the corpus is
      // subset-encoded with no usable cmap, the ligature comes back U+FFFD and
      // owes 1 where it owes 2, so the word balances while a letter is visibly
      // gone. That is the whole reason this producer exists.
      //
      // What stops it stacking on top of the ligature producer is not the budget
      // but the resolver's SLOT rule: both proposals name the same position and
      // the stronger one wins. See RANK.PAINTED_GLYPH.
      const here = stRow.filter((g) => Math.abs(g.x - dev.x) < SAME_POS && g.c === ch);
      // GATE 2 and GATE 4.
      if (!here.length || here.some((g) => g.x1 - g.x0 >= ZERO_W)) continue;
      const tail = here[0];
      if (tail.recovered || claimed.has(tail)) continue;

      // GATE 3.
      const lam = stRow.find((g) => g.c === "ل" && g.x1 - g.x0 >= ZERO_W &&
        Math.abs(g.x1 - tail.x) < SAME_POS);
      if (!lam) continue;
      const carriesMark = stRow.some((g) => TANWEEN.has(g.c) && Math.abs(g.x - tail.x) < SAME_POS);
      if (carriesMark) continue;

      claimed.add(tail);
      proposals.push({
        producer: "collided",
        rank: RANK.PAINTED_GLYPH,
        // Pays for itself: the evidence is a glyph the page painted, with its own
        // advance, not a subtraction. See the note at the gates above.
        funded: false,
        dev,
        anchor: tail,
        slotX: dev.x,
        slotY: dev.y,
        // The separate alef occupies the advance the device gave it, starting
        // where the ligature ends. Real width is what keeps it OUT of the
        // ligature's group and to the right of it, so the line reads alef, lam,
        // alef.
        glyph: {
          ...tail,
          c: ch,
          recovered: true,          // declared, never silent
          recoveredBy: "collided",
          ligatureLam: null,        // the copy must not inherit the pairing below
          x: dev.x, x0: dev.x, x1: dev.x + dev.advance,
          paintSeq: (tail.paintSeq ?? 0) + 0.5,
        },
        // Name the pair this alef belongs to. The two halves of THIS ligature are
        // not adjacent in emission order — stext emitted the lam, then the next
        // word's letters, then the tail — so the grouping passes, which walk
        // neighbours, never see it. Ungrouped they sort independently and the
        // recovered alef lands beside the wrong one: "االستغلال" for "الاستغلال".
        // Deferred with the insert: a rejected proposal must leave no trace.
        effects: () => { tail.ligatureLam = lam; },
      });
    }
  }

  return proposals;
}

/**
 * Restore an alef that carried a tanween and vanished from structured text.
 *
 * MEASURED, Chp1-Lec4-2 p2, truth "تماماً", got "تمامً":
 *
 *   structured text   "ً" x 269.12..269.12  w 0.00     then "م" at 273.76
 *   device path       "ً" x 269.54 adv 0.00
 *                     "ﺎ" x 269.63 adv 4.13  U+FE8E    <- the alef, still here
 *
 * Structured text dropped the base letter and left its mark behind, so the
 * tanween strands onto whatever follows and the word loses a character. The
 * device path names the glyph as a presentation form that decomposes to exactly
 * one character, so this RECOVERS evidence rather than inventing a letter —
 * the same reasoning that fixed the lam-alef case, and the reason `fontkit` is
 * not needed here either.
 *
 * Gates, in order, so the common case is a no-op BY CONSTRUCTION and not by
 * guard (that distinction is what separated the fix that worked from the three
 * that regressed the corpus):
 *   1. the baseline must be short — the device owes more characters than
 *      structured text supplied
 *   2. the device glyph must be an alef form with a real advance
 *   3. structured text must have NO alef at that position already
 *   4. a tanween must sit at that position — this is what makes the site
 *      identifiable rather than a general "insert missing glyphs" pass, which
 *      is a much larger piece of work (docs/SOLUTIONS.md P1)
 */
export function proposeTanweenAlef(glyphs, devs, budget) {
  if (!devs.length || !glyphs.length) return [];

  const devRows = byBaseline(devs);
  const stRows = byBaseline(glyphs);
  const proposals = [];
  const claimed = new Set();

  for (const [key, devRow] of devRows) {
    let stRow = stRows.get(key);
    if (!stRow) {
      for (let d = -Math.round(SAME_BASELINE * 10); d <= Math.round(SAME_BASELINE * 10) && !stRow; d++) {
        stRow = stRows.get(key + d);
      }
    }
    if (!stRow) continue;

    for (const dev of devRow) {
      // GATE 1 — the alef's own WORD must be short, not merely its baseline.
      if (budget.deficitOf(dev) <= 0) continue;
      // GATE 2.
      const ch = ALEF_FORMS.get(dev.unicode);
      if (!ch || dev.advance < ZERO_W) continue;
      // GATE 3 — a slightly wider window than SAME_POS: the two paths disagree
      // by ~0.5pt at this site, and an alef that IS present must never be doubled.
      if (stRow.some((g) => g.c === ch && Math.abs(g.x - dev.x) < 1.5)) continue;
      // GATE 4.
      const mark = stRow.find((g) => TANWEEN.has(g.c) && Math.abs(g.x - dev.x) < 1.5);
      if (!mark || claimed.has(mark)) continue;
      claimed.add(mark);

      // The mark is painted BEFORE the letter it sits on and shares its origin
      // (see groupAtomicUnits), so the alef goes in immediately after it at the
      // mark's origin. It must be ZERO WIDTH, which is counter-intuitive and was
      // measured the hard way: `byOriginThenPaint` compares RIGHT EDGE before it
      // compares base-versus-mark, so an alef carrying the device's real advance
      // sorts AFTER its own zero-width mark and the word comes out "تمامًا"
      // instead of "تماماً" — all the right characters, wrong order, and the
      // corpus moved 81.52% -> 81.53% while quietly trading 108 substitution
      // misses for 114 new ordering ones. Structured text reports a mark-carrying
      // base as zero width in this corpus for exactly this reason: the right
      // edges tie and `groupRank` decides. Matching that shape makes the existing
      // rules do the work, with no second code path.
      proposals.push({
        producer: "tanween",
        rank: RANK.NAMED_FORM,
        funded: true,
        dev,
        anchor: mark,
        slotX: mark.x,
        slotY: dev.y,
        glyph: {
          ...mark,
          c: ch,
          isMark: false,
          recovered: true,          // declared, never silent
          recoveredBy: "tanween",
          x: mark.x, x0: mark.x, x1: mark.x,
          paintSeq: (mark.paintSeq ?? 0) + 0.5,
        },
      });
    }
  }

  return proposals;
}

/**
 * Restore ANY base letter that carried a combining mark and vanished from stext.
 *
 * `proposeTanweenAlef` above is one instance of a defect that is not about alefs
 * and not about tanween. Structured text reports a mark-carrying base at the
 * MARK's origin, and where the two collide it emits the MARK ALONE and drops the
 * letter underneath it. Half the corruptions a reader reported on
 * `Chp1-Lec3-2(New)` are this one shape, with three different letters and two
 * different marks:
 *
 *   يُعدّ -> يُعّ    device U+FEAA "ﺪ" adv 5.19 at x 485.08, stext there: "ّ" alone
 *   العدّ -> العّ    the same dal, the same shadda
 *   ثوانٍ -> ثوا.ٍ   device U+FEE8 "ﻨ", stext there: the kasratan alone — and the
 *                   sentence's full stop then sorts INSIDE the word
 *   جودةً -> جودً    device U+FE93 "ﺓ", stext there: the fathatan alone; and
 *                   `tanween-missing-alef` then "repairs" that to `جوداً`,
 *                   because a bare fathatan with no alef is exactly its signature
 *
 * So the widening is along two axes and both are needed: the LETTER (any
 * presentation form naming exactly one letter, not only the eight alef forms) and
 * the MARK (any combining mark, not only the three tanween).
 *
 * The evidence is unchanged and is still a reading rather than a guess: the
 * device names the glyph as a presentation form, Unicode says which single letter
 * that form is, and the word is short by at least one character. Nothing here
 * decides WHICH letter — the font does.
 *
 * Gates, in the order that keeps the common case a no-op by construction:
 *   1. the glyph's own WORD is short (never its baseline — see attribute.js)
 *   2. the device glyph is a presentation form standing for exactly one letter,
 *      with a real advance
 *   3. structured text has no such letter at that position already
 *   4. a combining mark sits at that position and has not been claimed
 */
export function proposeMarkedBase(glyphs, devs, budget) {
  if (!devs.length || !glyphs.length) return [];

  const devRows = byBaseline(devs);
  const stRows = byBaseline(glyphs);
  const proposals = [];
  const claimed = new Set();

  for (const [key, devRow] of devRows) {
    let stRow = stRows.get(key);
    if (!stRow) {
      for (let d = -Math.round(SAME_BASELINE * 10); d <= Math.round(SAME_BASELINE * 10) && !stRow; d++) {
        stRow = stRows.get(key + d);
      }
    }
    if (!stRow) continue;

    for (const dev of devRow) {
      // GATE 2 — one glyph, one or more letters, and the font names every one of
      // them. A LIGATURE under a mark loses both its letters at once, measured on
      // `Chp1-Lec3-2(New)` p18, truth `إفشالاً`, got `إفشاً`:
      //
      //   device  x 275.68 adv 0.00  U+064B            the fathatan
      //           x 275.92 adv 6.61  U+FEFB  parts لا  the ligature — 2 owed
      //   stext   x 275.92 w 0.00    "ً"               the mark ALONE
      //
      // The word is short by exactly 2, which is what the glyph owes. Nothing
      // about this differs from the single-letter case except the arity.
      const parts = SINGLE_LETTER_FORMS.has(dev.unicode)
        ? [SINGLE_LETTER_FORMS.get(dev.unicode)]
        : dev.parts?.length >= 2 ? dev.parts : null;
      if (!parts || dev.advance < ZERO_W) continue;
      // GATE 1 — the glyph's own WORD must be able to afford EVERY letter this
      // glyph owes, never just the first. Half a ligature is worse than none.
      if (budget.deficitOf(dev) < parts.length) continue;
      // GATE 3 — the same 1.5pt window `proposeTanweenAlef` uses: the two paths
      // disagree by about half a point at these sites, and a letter that IS
      // present must never be doubled. Any part already there disqualifies the
      // whole proposal — a ligature that lost one half is the ligature
      // producer's business, and it holds the evidence for which half.
      if (parts.some((ch) => stRow.some((g) => g.c === ch && Math.abs(g.x - dev.x) < 1.5))) continue;
      // GATE 4.
      const mark = stRow.find((g) => isCombiningMark(g.c) && Math.abs(g.x - dev.x) < 1.5);
      if (!mark || claimed.has(mark)) continue;
      claimed.add(mark);

      // Zero width at the mark's origin, immediately after it — the shape stext
      // itself uses for a mark-carrying base, so `groupAtomicUnits` binds the
      // cluster and `visualToLogical` orders base-then-mark with no second code
      // path. Carrying the device's real advance instead sorts the base AFTER
      // its own mark and yields every right character in the wrong order, which
      // is the measurement recorded on `تماماً` in the producer above.
      const inserted = parts.map((ch, i) => ({
        ...mark,
        c: ch,
        isMark: false,
        recovered: true,          // declared, never silent
        recoveredBy: "markedBase",
        x: mark.x, x0: mark.x, x1: mark.x,
        paintSeq: (mark.paintSeq ?? 0) + (i + 1) / (parts.length + 1),
      }));
      // Name the pair so `groupAtomicUnits` keeps the halves together and in
      // order. Both are zero width at one origin, so nothing geometric can pair
      // them and, ungrouped, they sort on paint order alone.
      for (let i = 1; i < inserted.length; i++) inserted[i].ligatureLam = inserted[0];

      proposals.push({
        producer: "markedBase",
        rank: RANK.NAMED_FORM,
        funded: true,
        cost: parts.length,
        dev,
        anchor: mark,
        slotX: mark.x,
        slotY: dev.y,
        glyph: inserted,
      });
    }
  }

  return proposals;
}

/*
 * DO NOT ADD A "LINE EDGE" PRODUCER HERE WITHOUT READING THIS FIRST.
 * Built, measured three ways and REFUSED on 2026-08-21.
 *
 * THE DEFECT IS REAL. On an authored line reading `منتجات عالية جودةً` the two
 * paths disagree about how long the line is — device 18 glyphs, structured text
 * 16 — and the missing `ﺓ` U+FE93 (advance 6.90) and `ً` U+064B sit LEFT of
 * everything stext reported. The line is TRUNCATED. `proposeMarkedBase` cannot
 * reach it because its GATE 4 needs the MARK to be present as an anchor, and
 * here the mark is missing too.
 *
 * THE PRODUCER. Evidence-only, no Arabic in it: walk outward from the row's own
 * span, take device glyphs that ABUT the edge in a contiguous run, stop at a
 * space, skip anything a stext glyph already occupies, require the WORD's own
 * deficit to fund each base letter, and restore the exact codepoints from the
 * glyph's Unicode decomposition. It works: the synthetic factory goes 32/35 to
 * **35/35, 100%** on the Chromium route, closing three authored items.
 *
 * AND IT COSTS REAL DOCUMENTS, EVERY WAY IT WAS BUILT:
 *
 *   anchor: null                  0 fixed,  6 broken, 47 blocks re-keyed
 *   real anchors, one per side    0 fixed,  6 broken, 47 blocks re-keyed
 *   rows keyed on baselineY       0 fixed, 92 broken, 47 blocks re-keyed
 *
 * **Zero fixed, in all three.** The corpus does contain the shape — on
 * `Chp4-Lec23-1` p9 the device paints `ً`@37.2 and `ﺎ`@37.5 while stext's row
 * starts at 41.7 — but those words are ALREADY correct in the delivered text,
 * because `proposeTanweenAlef` puts that alef back from the other direction and
 * is measured at +91. This producer outranks it (`PAINTED_GLYPH` beats
 * `NAMED_FORM`), displaces it, and lands a second copy in a slightly worse
 * cluster shape. Keying rows on the true baseline — which is the RIGHT model,
 * and is why `attributePage` exists — made it worse, not better: 6 broken to 92.
 *
 * So the honest reading is not "the gate needs sharpening". It is that on real
 * documents this defect is already covered by a better-measured producer, and
 * the only evidence for this one is three authored fixtures. A rule that has
 * never fixed a single corpus block and breaks 92 is not a narrow miss.
 *
 * IF IT IS TRIED AGAIN, the thing to establish FIRST is a document where the
 * defect survives the existing repairs — not a fixture, a document. Without one
 * there is no prize to weigh the 92 against. See KNOWN_ISSUES 2026-08-21.
 */
