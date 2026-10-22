/**
 * How many combining marks have NO BASE, and is that the `EXTRA char "ً"` class?
 *
 * A combining mark is painted OVER the letter it belongs to, so its origin falls
 * inside that letter's advance box. A mark whose origin falls inside no box at
 * all belongs to nothing on the line. Measured example, Chp4-Lec23-1 p2 — the
 * source paragraph is "تتمحور", the PDF paints a fathatan at x 666.00 (the right
 * margin, zero advance, past the end of every letter) and the line comes out
 * "تًتمحور".
 *
 * Two candidate definitions are counted side by side, because the difference
 * between them is the whole question: a mark sitting exactly ON the right edge
 * of the line's first letter is either that letter's mark or an orphan, and
 * guessing costs the blocks that are currently CORRECT.
 *
 *   node experiments/probe-orphan-marks-corpus.js [samples]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, isCombiningMark } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 10);

/** A mark's origin is inside no letter's advance box. */
function unbased(block) {
  const bases = block.glyphs.filter((g) => !isCombiningMark(g.c) && g.c.trim());
  return block.glyphs.filter((m) =>
    isCombiningMark(m.c) && !bases.some((b) => b.x0 <= m.x0 && m.x0 < b.x1));
}

/** Nothing at all to the mark's right — it cannot precede a base in RTL order. */
function pastLineStart(block) {
  const bases = block.glyphs.filter((g) => !isCombiningMark(g.c) && g.c.trim());
  if (!bases.length) return [];
  const rightmost = Math.max(...bases.map((b) => b.x1));
  return block.glyphs.filter((m) => isCombiningMark(m.c) && m.x0 >= rightmost - 0.01);
}

/**
 * The same, restricted to TANWEEN (nunation). Arabic nunation marks the END of
 * a word, so it cannot sit on the first letter of a line — words do not split
 * across lines. A damma or a shadda can and does.
 */
const isTanween = (ch) => /[\u064B-\u064D]/.test(ch);
const pastLineStartTanween = (block) => pastLineStart(block).filter((m) => isTanween(m.c));

const tally = {};
const count = (rule, key) => { (tally[rule] ??= {})[key] = (tally[rule][key] ?? 0) + 1; };
const shown = { unbased: [], pastLineStart: [], pastLineStartTanween: [] };
let blocks = 0, marks = 0;

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

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const rtl = blockIsRtl(b);
      const got = normalize(blockText(b, rtl));
      if (!got) continue;
      blocks++;
      marks += b.glyphs.filter((g) => isCombiningMark(g.c)).length;
      const okNow = truthAll.includes(got);

      for (const [rule, find] of [["unbased", unbased], ["pastLineStart", pastLineStart], ["pastLineStartTanween", pastLineStartTanween]]) {
        const drop = find(b);
        if (!drop.length) continue;
        const without = normalize(blockText({ ...b, glyphs: b.glyphs.filter((g) => !drop.includes(g)) }, rtl));
        if (without === got) { count(rule, "no change to the text"); continue; }
        const okAfter = truthAll.includes(without);
        count(rule, okNow ? (okAfter ? "was right, still right" : "WAS RIGHT, BROKEN") : (okAfter ? "FIXED" : "was wrong, still wrong"));
        if (shown[rule].length < SAMPLES && okNow && !okAfter) {
          shown[rule].push(`${pair.name} p${p + 1}\n      kept    ${got.slice(0, 84)}\n      dropped ${without.slice(0, 84)}`);
        }
      }
    }
  }
}

console.log(`blocks ${blocks}   marks ${marks}\n`);
for (const [rule, cells] of Object.entries(tally)) {
  console.log(rule);
  for (const [k, v] of Object.entries(cells).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  for (const s of shown[rule]) console.log(`    REGRESSION ${s}`);
  console.log();
}
