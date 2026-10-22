/**
 * Device-path glyph evidence, used to repair what the structured-text path loses.
 *
 * MEASURED (Chp1-Lec1-3(New).pdf p2, both paths at identical x positions):
 *
 *   x        structured text        device path
 *   479.31   "ا" U+0627  w 0.00     "ﺎ" U+FE8E  adv 0.306
 *   470.81   "ل" U+0644  ONE char   "ﻻ" U+FEFB  adv 0.630   <- two characters
 *
 * A lam-alef ligature is ONE painted glyph standing for TWO characters. MuPDF's
 * ToUnicode for that glyph yields only the lam, so the alef is lost: "الريالات"
 * extracts as "الريلات". The device path reports the glyph's real identity as an
 * Arabic Presentation Form, which decomposes unambiguously.
 *
 * This is why no font parsing is needed. An earlier plan (docs/SOLUTIONS.md P1
 * Fix A) proposed reading the font's GSUB table via fontkit; the presentation
 * form already carries the same information and ships with no new dependency.
 *
 * NOTE ON COORDINATES: `showGlyph`'s `trm` is in content-stream space. The `ctm`
 * handed to `fillText` MUST be concatenated or the positions land in a different
 * space entirely (measured on this corpus: a 4/3 scale), and every position
 * lookup silently misses. Two earlier probes failed exactly this way.
 */
import * as mupdf from "mupdf";

/**
 * The eight Arabic presentation forms that stand for two base characters.
 * Isolated and final variants both decompose to the same pair.
 */
export const LAM_ALEF_LIGATURES = new Map([
  [0xfef5, ["ل", "آ"]], [0xfef6, ["ل", "آ"]],  // lam + alef madda
  [0xfef7, ["ل", "أ"]], [0xfef8, ["ل", "أ"]],  // lam + alef hamza above
  [0xfef9, ["ل", "إ"]], [0xfefa, ["ل", "إ"]],  // lam + alef hamza below
  [0xfefb, ["ل", "ا"]], [0xfefc, ["ل", "ا"]],  // lam + alef
]);

/** Position key. Tenths of a point: the two paths agree to well within that. */
export const posKey = (x, y) => `${Math.round(x * 10)}:${Math.round(y * 10)}`;

/**
 * Every painted glyph on the page, keyed by page-space position.
 *
 * Only `fillText` is observed. Text painted as a clip or stroke is not reported,
 * which is safe: a missing entry simply means no repair is attempted there.
 */
export function deviceGlyphs(page) {
  const byPos = new Map();

  const device = new mupdf.Device({
    fillText(text, ctm) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          const x = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4];
          const y = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5];
          // Effective em size of this glyph in page units, so the font's em-based
          // advance can be compared against structured-text quad widths.
          const sx = ctm[0] * trm[0] + ctm[2] * trm[1];
          const sy = ctm[1] * trm[0] + ctm[3] * trm[1];
          const em = Math.hypot(sx, sy);
          byPos.set(posKey(x, y), {
            gid: glyph,
            unicode,
            advance: font.advanceGlyph(glyph) * em,
            font: font.getName(),
          });
        },
      });
    },
    fillPath() {}, strokePath() {}, clipPath() {}, clipStrokePath() {},
    strokeText() {}, clipText() {}, clipStrokeText() {}, ignoreText() {},
    fillShade() {}, fillImage() {}, fillImageMask() {}, clipImageMask() {},
    popClip() {}, beginMask() {}, endMask() {}, beginGroup() {}, endGroup() {},
    beginTile() { return 0; }, endTile() {}, close() {}, drop() {},
  });

  page.run(device, mupdf.Matrix.identity);
  device.close();
  return byPos;
}

/** Distance (pt) within which two reports describe the same glyph. */
const SAME_POS = 0.6;
/** A quad narrower than this carries no advance. */
const ZERO_W = 0.5;

/**
 * Give back the advance that structured text reports as zero.
 *
 * MEASURED: a real final-form alef (device U+FE8E, advance 0.306em ~ 4.13pt)
 * arrives from stext with a zero-width quad. That matters beyond geometry — the
 * zero-width rule in glyphs.js groupAtomicUnits binds any zero-width glyph that
 * abuts its neighbour into a ligature unit, so a real letter gets swallowed into
 * the preceding lam-alef and frozen in the wrong order ("لاات" for "الات").
 *
 * Only glyphs the DEVICE says carry an advance are widened. A ligature tail that
 * stext synthesised has no device glyph of its own and stays zero-width, and so
 * do combining marks, which genuinely have no advance.
 */
export function restoreAdvances(glyphs, evidence) {
  if (!evidence.size) return glyphs;
  for (const g of glyphs) {
    if (g.x1 - g.x0 >= ZERO_W) continue;
    const ev = evidence.get(posKey(g.x, g.y));
    if (!ev || ev.advance < ZERO_W) continue;
    g.x1 = g.x0 + ev.advance;
    g.advanceRestored = true;
  }
  return glyphs;
}

/**
 * Is a device glyph painted at roughly this position?
 *
 * The tail position is derived arithmetically (lam origin + advance) so it can
 * land a hundredth either side of the key boundary; check the neighbouring
 * buckets rather than trusting one rounding.
 */
function hasDeviceNear(evidence, x, y) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (evidence.has(`${Math.round(x * 10) + dx}:${Math.round(y * 10) + dy}`)) return true;
    }
  }
  return false;
}

/**
 * Re-insert the alef that a lam-alef ligature drops.
 *
 * The synthetic alef deliberately copies the exact shape MuPDF produces when it
 * DOES decompose a ligature itself — origin at the lam's right edge, zero width,
 * emitted immediately after the lam (see the measured example in glyphs.js
 * groupAtomicUnits). That way the existing zero-width grouping rule binds it into
 * the same atomic unit and `visualToLogical` preserves lam-then-alef order,
 * instead of needing a second, parallel code path.
 *
 * @param {object[]} glyphs   structured-text glyphs, in emission order
 * @param {Map} evidence      from `deviceGlyphs(page)`
 * @returns {object[]} glyphs with recovered alefs spliced in
 */
export function recoverLigatures(glyphs, evidence) {
  if (!evidence.size) return glyphs;

  const out = [];
  for (const g of glyphs) {
    out.push(g);

    const ev = evidence.get(posKey(g.x, g.y));
    if (!ev) continue;
    const pair = LAM_ALEF_LIGATURES.get(ev.unicode);
    if (!pair) continue;

    const [lam, alef] = pair;
    if (g.c !== lam) continue;   // stext gave something else entirely; leave it alone

    // Structured text usually decomposes the ligature itself, emitting a
    // zero-width tail at the lam's right edge. It is NOT safe to detect that by
    // shape: KNOWN_ISSUES records two encodings (zero-width tail or zero-width
    // lead), and a shape test regressed the corpus 81.09% -> 63.28%.
    //
    // Count instead. The tail's position frequently coincides with a real
    // neighbouring glyph, and when it does stext emits ONE character where TWO
    // belong — that collision is the actual defect. So at the tail position,
    // expect one character for any real device glyph there plus one for the
    // ligature's own alef, and only inject when stext came up short.
    const qx = g.x + (ev.advance || g.x1 - g.x0);
    const expected = (hasDeviceNear(evidence, qx, g.y) ? 1 : 0) + 1;
    const supplied = glyphs.filter(
      (o) => Math.abs(o.y - g.y) < SAME_POS && Math.abs(o.x - qx) < SAME_POS
    ).length;
    if (supplied >= expected) continue;

    out.push({
      ...g,
      c: alef,
      recovered: true,          // declared, never silent — the doctor can surface it
      x: qx,
      x0: qx,
      x1: qx,
      paintSeq: g.paintSeq + 0.5,
    });
  }

  return out;
}
