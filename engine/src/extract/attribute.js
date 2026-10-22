/**
 * Who owns which character, and which WORD is short.
 *
 * THE DEFECT THIS REPLACES. The three repairs in `ligatures.js` each computed
 * their own budget as "characters the device owes on this BASELINE minus
 * characters structured text put on it". Every part of that is wrong in a way
 * that costs blocks:
 *
 *   the baseline is too coarse   a row holds many words, so a character missing
 *                                from one word licenses a repair in another. The
 *                                whole `بُني` -> `بُيني` failure is this: the row
 *                                was short an alef in `شراء` and the ligature
 *                                repair spent it on `بُني`'s tail, two words away.
 *   the baseline is also WRONG    structured text reports a mark-carrying base on
 *                                its MARK's baseline — `ب` at y 85.39 while the
 *                                device paints its glyph at y 93.00 — so a 0.6pt
 *                                row filter counts that word as two characters
 *                                against three owed and invents the deficit it
 *                                then spends.
 *   the budget was SHARED        three repairs recomputing one number from the
 *                                stream they were handed means whichever runs
 *                                first spends it. Measured: the shipped order is
 *                                the worst of six, costing +7 blocks for nothing.
 *
 * WHAT REPLACES IT. Rows come from the DEVICE's y, which is the true baseline.
 * Characters are attributed one owner each, by half-open advance span. The budget
 * is per WORD. Measured over the three decisive sites:
 *
 *   Chp4-Lec23-1 p7   MUST INSERT   deficit 1 on `التشغيل`   correct
 *   Chp1-Lec2-1 p20   MUST NOT      deficit 0 on `بُني`      the failure, dissolved
 *   Chp3-Lec19  p2    MUST NOT      deficit 0 on `التشغيلي`  (its row's real
 *                                   deficit is an alef in `لأتمتة`, elsewhere)
 *
 * Nothing here inserts, deletes or reorders anything. It answers two questions —
 * who owns this character, and is this word short — and every repair asks instead
 * of computing its own answer.
 *
 * MARKS ARE IDENTIFIED FROM THE CHARACTER, never from a flag. This runs on the
 * RAW structured-text stream, before `groupAtomicUnits` sets `isMark`, so reading
 * that flag here silently counted every combining mark as a supplied base letter:
 * any word carrying a mark read deficit 0, the tanween repair was starved at
 * precisely the sites it exists for, and the corpus lost 199 blocks. The
 * diagnostic dump disagreed and looked correct, because it inspects the stream
 * AFTER grouping — EVO-028, a rule measured from one vantage point behaving
 * differently where it actually runs.
 */
import { isCombiningMark } from "./bidi.js";

/** Two device glyphs share a row within this vertical distance (pt). */
const SAME_ROW = 0.6;
/** Positional slack between the two streams' reports of one position (pt). */
const EPS = 0.3;
/**
 * A gap wider than this ends a word.
 *
 * Splitting on the device's own space glyphs alone is not enough: on
 * `Chp4-Lec23-1` p7 a line jumps from x 210.49 to x 546.84 with no space glyph
 * between, which glued `الانحراف`, `التشغيلي` and `25` into one 16-glyph unit and
 * put them back on a shared budget — the exact coupling this module removes.
 * 2.5pt clears the measured intra-word maximum (1.50pt, letter-spaced text at
 * 18pt) with margin, and shaped Arabic abuts at 0.00pt.
 */
const WORD_GAP = 2.5;
/** Anything narrower than this carries no advance. */
const ZERO_ADV = 0.01;

/** A device glyph standing for whitespace. Its debt is a space, not a letter. */
const isSpaceGlyph = (d) => d.unicode === 0x20 || d.unicode === 0xa0;

/**
 * A zero-advance combining mark, as the DEVICE reports it.
 *
 * Excluded from owning base characters, and not tidiness: a mark sits at (or a
 * hair after) the origin of the letter it decorates, so as an owner it steals
 * that letter and its neighbours. Measured at the `بُني` site — the damma at
 * 513.95 claimed `ي`, `ب` and itself, and the band read a deficit of 2 where the
 * truth is 0.
 */
const isMarkGlyph = (d) =>
  d.advance < ZERO_ADV && d.unicode > 0 && /\p{Mn}/u.test(String.fromCodePoint(d.unicode));

/** Only these glyphs owe, and can own, base characters. */
const owesBases = (d) => !isSpaceGlyph(d) && !isMarkGlyph(d);

/** Device glyphs grouped onto their own baselines. */
function deviceRows(devs) {
  const rows = [];
  for (const d of devs) {
    let row = rows.find((r) => Math.abs(r.y - d.y) <= SAME_ROW);
    if (!row) { row = { y: d.y, devs: [] }; rows.push(row); }
    row.devs.push(d);
  }
  for (const r of rows) r.devs.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * The advance span of a device glyph reaches this x. CLOSED at both ends.
 *
 * A half-open span was tried first and is wrong for the one case this project
 * exists for: a LIGATURE TAIL sits exactly at the end of its glyph's advance, so
 * an exclusive upper bound leaves it with no owner on its own line — and the
 * search then adopted it onto whatever other line happened to cover that x.
 * Measured: an alef at y=321.00 was attributed to a word at y=232.50, 88pt away,
 * which inflated that word's supply, hid a real deficit, and starved the tanween
 * repair on the two blocks that regressed.
 *
 * Closed spans do NOT reintroduce double-counting, because attribution runs once
 * per CHARACTER rather than once per glyph: where two adjacent glyphs both reach a
 * boundary character, the later origin takes it and the earlier one does not.
 * Both are in the same word, so the word's count is unchanged either way — the
 * boundary choice was never what the budget depended on.
 */
function covers(d, x) {
  return x >= d.x - EPS && x <= d.x + Math.max(d.advance, 0) + EPS;
}

/**
 * How far from a device row a character may sit and still belong to it (pt).
 *
 * Structured text puts a mark-carrying base on its MARK's baseline — measured at
 * 7.6pt off its own line — and a shadda-raised cluster strands about 8.3pt off, so
 * the limit cannot be tight. But it must EXIST: without one, a character whose own
 * line has no glyph reaching it is attributed to the nearest line that does, at
 * any distance, and one at 88pt away is what hid the defect above. Past this, a
 * character is left unowned, which understates supply and can only make a repair
 * more conservative — the safe direction.
 */
const MAX_ROW_DY = 12;

/**
 * Words in one device row: runs separated by a space glyph or an unexplained gap.
 * Marks and spaces stay in the row but never open or extend a word.
 */
function wordsInRow(row) {
  const words = [];
  let prev = null, cur = null;
  for (const d of row.devs) {
    const gap = prev ? d.x - (prev.x + Math.max(prev.advance, 0)) : 0;
    if (isSpaceGlyph(d) || gap > WORD_GAP) cur = null;
    prev = d;
    if (!owesBases(d)) continue;
    if (!cur) { cur = { devs: [], chars: [], owed: 0, supplied: 0, deficit: 0 }; words.push(cur); }
    cur.devs.push(d);
    cur.owed += d.owed ?? 1;
  }
  return words;
}

/**
 * Attribute every character to a glyph, and price every word.
 *
 * @param {object[]} glyphs structured-text glyphs
 * @param {object[]} devs   from `deviceGlyphs(page, arity)`
 * @returns {{deficitOf:(d:object)=>number, spend:(d:object)=>boolean,
 *            wordOf:(d:object)=>object|null, charsOf:(d:object)=>object[],
 *            words:object[]}}
 */
export function attributePage(glyphs, devs) {
  const rows = deviceRows(devs);
  const words = rows.flatMap(wordsInRow);

  const wordOf = new Map();
  for (const w of words) for (const d of w.devs) wordOf.set(d, w);

  const charsOf = new Map();
  for (const d of devs) charsOf.set(d, []);
  /** character -> the device glyph that owns it, so its TRUE baseline is known. */
  const ownerOf = new Map();

  for (const g of glyphs) {
    if (!g.c || !g.c.trim()) continue;              // spaces are not attributed
    // Rows that can reach this character at all. The row is chosen before the
    // glyph so structured text's unreliable y is only ever a TIE-BREAK: the `ب`
    // reported 7.6pt above its line is offered to the one row whose advances
    // actually cover its x, which is the row the device painted it on.
    let best = null, bestDy = Infinity, bestX = -Infinity;
    for (const r of rows) {
      const dy = Math.abs(r.y - g.y);
      if (dy > MAX_ROW_DY) continue;                  // never attribute across lines
      for (const d of r.devs) {
        if (!owesBases(d) || !covers(d, g.x)) continue;
        // Nearest row wins; inside a row, the LAST origin at or before the
        // character wins, which is what a pen does.
        if (dy < bestDy - 0.01 || (Math.abs(dy - bestDy) <= 0.01 && d.x > bestX)) {
          best = d; bestDy = dy; bestX = d.x;
        }
      }
    }
    if (!best) continue;                            // no advance reaches it: a gap, not a loss
    charsOf.get(best).push(g);
    ownerOf.set(g, best);
    const w = wordOf.get(best);
    if (w && !isCombiningMark(g.c)) { w.supplied++; w.chars.push(g); }
  }

  for (const w of words) w.deficit = Math.max(0, w.owed - w.supplied);

  return {
    words,
    wordOf: (d) => wordOf.get(d) ?? null,
    charsOf: (d) => charsOf.get(d) ?? [],
    /** Characters this glyph's WORD is still short. 0 for spaces and marks. */
    deficitOf: (d) => wordOf.get(d)?.deficit ?? 0,
    /**
     * The baseline the DEVICE painted this character on, which is not always the
     * one structured text reports. A shadda or damma raises the reported origin —
     * measured at 10.8 and 11.9pt on `Chp1-Lec6-2` p11, where `ذ` and `ت` claim
     * y=81 while their glyphs are painted at y=93 — and the row grouping then
     * files them as a line of their own, stranding whole words above the line they
     * belong to. Returns null when nothing owns the character; the caller keeps
     * whatever structured text said.
     */
    baselineOf: (g) => ownerOf.get(g)?.y ?? null,
    /**
     * Charge one character to this glyph's word. Returns false when the word has
     * nothing left to spend, which is the whole point of a per-word budget: two
     * repairs cannot both spend the same missing character, and a repair cannot
     * spend a character missing from a different word.
     */
    spend: (d, n = 1) => {
      const w = wordOf.get(d);
      // All or nothing. A ligature under a mark owes two characters, and a
      // partial charge would let it put back a lam with no alef — worse than the
      // loss it was repairing.
      if (!w || w.deficit < n) return false;
      w.deficit -= n;
      return true;
    },
  };
}
