/**
 * Recover glyphs the PDF renders but does not encode.
 *
 * MEASURED PROBLEM. In "والانحراف" MuPDF emits 8 glyphs for 9 letters: the alef
 * of the definite article has no ToUnicode entry, so no character is produced.
 * pdf.js does far worse on this corpus (20 Arabic chars per page vs ~800), and
 * no MuPDF option recovers it — the mapping simply is not in the font subset.
 *
 * WHAT SURVIVES. The glyph was still *drawn*, so its advance is still there:
 *
 *   ل  [288.29, 294.42]        <- lam-alef ligature
 *   ا  [294.42, 294.42] w 0    <- its zero-width tail
 *   (gap 294.42 -> 296.73 = 2.31pt, nothing emitted)
 *   و  [296.73, 301.97]
 *
 * Every other glyph in that word abuts at 0.00pt, and 2.31pt is exactly the
 * advance of an alef in that font at that size — measured from other alefs on
 * the same page. So the document tells us both that a glyph is missing and
 * which one it was.
 *
 * This is deliberately conservative: it fires only inside a word, only on a
 * clear outlier gap, and only when exactly one character in that font and size
 * matches the width. Anything ambiguous is left alone and reported.
 */

/** Gap must exceed this (pt) before it is considered a hole at all. */
const MIN_HOLE = 1.2;
/** Observed advance must match the hole within this (pt) to be a candidate. */
const WIDTH_TOL = 0.25;
/** A candidate must account for this share of observations to be unambiguous. */
const DOMINANCE = 0.8;

const key = (g) => `${g.font}|${g.size.toFixed(1)}`;

/**
 * Character -> typical advance, per font and size, learned from the page itself.
 * Only single non-space, non-mark characters with positive width are recorded.
 */
export function buildAdvanceTable(glyphs) {
  const table = new Map();
  for (const g of glyphs) {
    const w = g.x1 - g.x0;
    if (w <= 0.1 || g.isMark || !g.c.trim()) continue;
    const k = key(g);
    if (!table.has(k)) table.set(k, new Map());
    const byChar = table.get(k);
    if (!byChar.has(g.c)) byChar.set(g.c, []);
    byChar.get(g.c).push(w);
  }
  return table;
}

/** Characters in this font/size whose advance matches `hole`. */
function candidatesFor(table, g, hole) {
  const byChar = table.get(key(g));
  if (!byChar) return [];
  const out = [];
  for (const [ch, widths] of byChar) {
    const near = widths.filter((w) => Math.abs(w - hole) <= WIDTH_TOL).length;
    if (near && near / widths.length >= DOMINANCE) out.push({ ch, n: near });
  }
  return out.sort((a, b) => b.n - a.n);
}

/**
 * Insert glyphs for unencoded holes in one visually-sorted block.
 * Returns { glyphs, repairs } — repairs is provenance, never silent.
 */
export function repairBlock(sortedGlyphs, table) {
  const out = [];
  const repairs = [];

  for (let i = 0; i < sortedGlyphs.length; i++) {
    const g = sortedGlyphs[i];
    out.push(g);
    const next = sortedGlyphs[i + 1];
    if (!next) continue;

    // A hole only counts inside a word: a real space already explains the gap.
    if (g.c === " " || next.c === " ") continue;
    const hole = next.x0 - g.x1;
    if (hole < MIN_HOLE) continue;

    const cands = candidatesFor(table, g, hole);
    if (cands.length !== 1) {
      repairs.push({ at: g.x1, hole: +hole.toFixed(2), resolved: null, candidates: cands.map((c) => c.ch) });
      continue;
    }

    const ch = cands[0].ch;
    out.push({
      c: ch,
      x: g.x1, x0: g.x1, x1: next.x0,
      y: g.y, size: g.size, font: g.font, family: g.family,
      paintSeq: g.paintSeq + 0.5,     // sorts stably between its neighbours
      repaired: true,
    });
    repairs.push({ at: g.x1, hole: +hole.toFixed(2), resolved: ch });
  }

  return { glyphs: out, repairs };
}
