/**
 * Every word boundary, with the geometry that should decide it.
 *
 * `withSpaces` suppresses the gap after a ZERO-WIDTH glyph. That guard is right for
 * Chrome and wrong for PowerPoint, and the fix must not be told which producer it is
 * looking at — the geometry has to say it. This probe dumps the evidence for both so
 * a rule can be derived rather than guessed.
 *
 * THE HYPOTHESIS IT TESTS. A zero-width glyph is structured text failing to report an
 * advance the page really painted. The question is WHERE that unreported advance
 * sits:
 *
 *   Chrome    a mark-carrying base INSIDE a word. Its origin falls in the interval
 *             between the two visible glyphs, so it plausibly fills that interval and
 *             the interval is not a word gap.
 *
 *                 visible ...x1        [hidden origin]        x0... visible
 *
 *   PowerPoint  a lam-alef ligature partner at the END of a word. Its origin sits
 *             BEHIND the previous visible glyph's right edge — tucked inside the
 *             cluster it belongs to — so it explains none of the gap that follows.
 *
 *                 visible ...[hidden origin]...x1        gap        x0... visible
 *
 * If that holds, the rule is "how much of this gap can the hidden glyph explain",
 * which mentions no producer at all.
 *
 * Usage: node experiments/synth/probe-boundaries.js
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { buildLines, extractGlyphs } from "../../src/extract/glyphs.js";
import { findPairs } from "../../src/truth/corpus.js";
import { requireSubjects } from "../lib-gate.js";

const SYNTH = path.resolve("out/synth/synth-powerpoint.pdf");
const ZERO = 0.5;          // the extractor's own ZERO_ADVANCE
const SPACE_GAP = 0.12;    // the extractor's own SPACE_GAP

/**
 * Walk a block's glyphs and describe every place a space could go.
 * Mirrors `withSpaces`'s own walk so the evidence describes the real decision.
 */
function boundaries(glyphs) {
  const out = [];
  let lastSolid = null;
  let hiddenGlyph = null;
  for (const g of glyphs) {
    if (g.isMark) continue;
    const zeroWidth = g.x1 - g.x0 < ZERO;
    if (zeroWidth) { hiddenGlyph = g; continue; }
    if (lastSolid) {
      const gap = g.x0 - lastSolid.x1;
      const size = Math.min(g.size, lastSolid.size) || 1;
      out.push({
        gap: +gap.toFixed(2),
        ratio: +(gap / size).toFixed(3),
        overGap: gap > size * SPACE_GAP,
        hidden: hiddenGlyph ? hiddenGlyph.c : null,
        // The whole question: does the hidden glyph's origin fall INSIDE the
        // interval it is being allowed to explain?
        hiddenInGap: hiddenGlyph ? hiddenGlyph.x0 > lastSolid.x1 && hiddenGlyph.x0 < g.x0 : null,
        hiddenBehind: hiddenGlyph ? +(lastSolid.x1 - hiddenGlyph.x0).toFixed(2) : null,
        prev: lastSolid.c, next: g.c,
      });
    }
    lastSolid = g;
    hiddenGlyph = null;
  }
  return out;
}

function collect(pdf, pageIndexes, label) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pdf), "application/pdf");
  const rows = [];
  for (const i of pageIndexes) {
    if (i >= doc.countPages()) continue;
    for (const blk of buildLines(extractGlyphs(doc.loadPage(i)))) {
      const text = blk.glyphs.map((g) => g.c).join("");
      if (!/[؀-ۿ]/.test(text)) continue;         // Arabic blocks only
      for (const b of boundaries(blk.glyphs)) rows.push({ ...b, label });
    }
  }
  return rows;
}

const synth = fs.existsSync(SYNTH) ? collect(SYNTH, [...Array(18).keys()], "PowerPoint") : [];
const pairs = findPairs();
const chrome = pairs.length ? collect(pairs[0].pdf, [0, 1, 2, 3, 4, 5], "Chrome") : [];

requireSubjects(synth.length + chrome.length, "boundaries",
  "run experiments/synth/build.js, and check the corpus root");

for (const [label, rows] of [["PowerPoint (synthetic)", synth], ["Chrome (corpus)", chrome]]) {
  const suppressed = rows.filter((r) => r.hidden && r.overGap);
  const inGap = suppressed.filter((r) => r.hiddenInGap);
  const behind = suppressed.filter((r) => !r.hiddenInGap);
  console.log(`\n${label}: ${rows.length} boundaries · ${rows.filter((r) => r.overGap).length} gaps over SPACE_GAP`);
  console.log(`  gaps SUPPRESSED by a hidden glyph: ${suppressed.length}`);
  console.log(`     hidden origin INSIDE the gap  : ${inGap.length}   <- it can explain the gap`);
  console.log(`     hidden origin BEHIND prev.x1  : ${behind.length}   <- it explains nothing`);
  const sample = (rs) => rs.slice(0, 4).map((r) =>
    `${JSON.stringify(r.prev)}|${JSON.stringify(r.hidden)}|${JSON.stringify(r.next)} gap ${r.gap} ratio ${r.ratio} behind ${r.hiddenBehind}`);
  for (const s of sample(inGap)) console.log(`       IN-GAP  ${s}`);
  for (const s of sample(behind)) console.log(`       BEHIND  ${s}`);
}

console.log("\nIf the two producers separate cleanly on `hiddenInGap`, the rule needs no");
console.log("producer name: suppress only when the hidden glyph can actually explain the gap.\n");
