/**
 * Did structured text simply SKIP a painted glyph?
 *
 * The repairs in `ligatures.js` all key on a ligature: one glyph standing for
 * two characters. The remaining drops look different — `يفصّل` comes out `يفل`,
 * `التشغيلي` comes out `التشغلي` — so before writing another ligature rule,
 * measure the simplest possible cause: a glyph the device painted with a real
 * advance, inside whose advance structured text put NO character at all.
 *
 * THE NAIVE VERSION OF THAT TEST IS WRONG and the number it produces is
 * seductive: 3634 holes, 98% of them named, a miss set of only ~600 blocks.
 * Structured text does not put a ligature's second character inside the
 * ligature's advance — it emits it with ZERO WIDTH at the pair's origin or at
 * its tail, which is nowhere near where the device painted that half. So the
 * naive test flags every ligature in the corpus.
 *
 * The honest test relaxes it and then CORRELATES: a detector for dropped
 * characters must fire on blocks that miss and stay quiet on blocks that match.
 * Both numbers are printed. If a rule fires as often on correct blocks, it is
 * measuring ligatures, not losses.
 *
 *   node experiments/probe-glyph-holes.js [samples]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, isCombiningMark } from "../src/extract/glyphs.js";
import { deviceGlyphs } from "../src/extract/ligatures.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 10);
const SAME_BASELINE = 0.6;
const ZERO_W = 0.5;
const EDGE = 0.3;
/** A shaped form may start this far from where the other stream puts it (pt). */
const NEARBY = Number(process.argv[3] ?? 3);

const cells = { holeInMiss: 0, holeInMatch: 0, blocksWithHole: 0, missBlocks: 0, matchBlocks: 0 };
const samples = [];
const byChar = new Map();

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);

  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p))).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truthAll = slideText[align[p]];
    const page = doc.loadPage(p);
    const devs = deviceGlyphs(page).filter((d) => d.advance >= ZERO_W);

    for (const b of buildLines(extractGlyphs(page))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      const miss = !truthAll.includes(got);
      miss ? cells.missBlocks++ : cells.matchBlocks++;

      const letters = b.glyphs.filter((g) => !isCombiningMark(g.c) && g.c.trim());
      if (!letters.length) continue;
      const x0 = Math.min(...letters.map((g) => g.x0)), x1 = Math.max(...letters.map((g) => g.x1));
      const y = b.glyphs[0].y;

      let holes = 0;
      for (const d of devs) {
        // Spaces are not comparable: `inhibit-spaces` leaves structured text with
        // only the real U+0020 glyphs, and the block's own letters are what this
        // walks. A space "hole" says nothing about a lost letter.
        if (d.unicode === 0x20 || d.unicode === 0xa0) continue;
        if (Math.abs(d.y - y) >= SAME_BASELINE) continue;
        if (d.x < x0 - 1 || d.x > x1 + 1) continue;
        // Relaxed: a character counts if its origin is anywhere in the glyph's
        // advance, OR it is zero width and sits at either end of it — which is
        // how structured text reports the halves of a ligature.
        const covered = letters.some((g) => {
          const inside = g.x >= d.x - EDGE && g.x < d.x + d.advance - EDGE;
          const zero = g.x1 - g.x0 < ZERO_W &&
            (Math.abs(g.x - d.x) < EDGE || Math.abs(g.x - (d.x + d.advance)) < EDGE);
          return inside || zero;
        });
        if (covered) continue;
        const ch = d.unicode > 0 && d.unicode !== 0xfffd
          ? String.fromCodePoint(d.unicode).normalize("NFKC") : "?";
        // The character IS there, a little to one side. Structured text and the
        // device disagree about where some shaped forms begin, and an identity
        // match within a letter's width is the same character, not a loss.
        if (ch !== "?" && letters.some((g) => ch.includes(g.c) && Math.abs(g.x - d.x) <= NEARBY)) continue;
        holes++;
        const cell = byChar.get(ch) ?? { miss: 0, match: 0 };
        cell[miss ? "miss" : "match"]++;
        byChar.set(ch, cell);
        miss ? cells.holeInMiss++ : cells.holeInMatch++;
        if (miss && samples.length < SAMPLES) {
          samples.push(`${pair.name} p${p + 1}  missing ${JSON.stringify(ch)} at x ${d.x.toFixed(2)}\n        got ${got.slice(0, 76)}`);
        }
      }
      if (holes) cells.blocksWithHole++;
    }
  }
}

console.log(`blocks: ${cells.matchBlocks} match, ${cells.missBlocks} miss`);
console.log(`holes in blocks that MISS : ${cells.holeInMiss}`);
console.log(`holes in blocks that MATCH: ${cells.holeInMatch}   <- must be near zero for this to be a detector`);
console.log(`blocks holding at least one hole: ${cells.blocksWithHole}`);
console.log(`\ncharacters the device painted and structured text has nowhere:`);
console.log(`   in MISS  in MATCH  character`);
for (const [c, n] of [...byChar].sort((a, b) => (b[1].miss + b[1].match) - (a[1].miss + a[1].match)).slice(0, 18)) {
  console.log(`  ${String(n.miss).padStart(7)}  ${String(n.match).padStart(8)}  ${JSON.stringify(c)}`);
}
console.log();
for (const s of samples) console.log(`  ${s}`);
