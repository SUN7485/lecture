/**
 * WHICH STAGE loses the character?
 *
 * Cheaper than a full provenance ledger and enough to name the guilty stage.
 * Count one codepoint at every hand-off on ONE page:
 *
 *   raw walk            what MuPDF's structured text emits, before any repair
 *   extractGlyphs       + the ligature/tanween/alef repairs and the grouping
 *   buildLines          the sum over every block's glyphs
 *   blockText           the sum over the finished, bidi-ordered strings
 *
 * Reading the result:
 *   drops at extractGlyphs   a repair or the grouping pass eats it
 *   drops at buildLines      a glyph reached no block at all
 *   drops at blockText       withSpaces / visualToLogical loses it
 *   constant everywhere      nothing is lost; the defect is ORDER or the scorer
 *
 * The last line is the one that matters here: the page total being conserved
 * while a block is short means the character went somewhere else on the page.
 *
 *   node experiments/probe-stage-histogram.js <deck> <page1based> [char]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const [deck, pageArg, chArg] = process.argv.slice(2);
const CH = chArg ?? "ي";
const pair = findPairs().find((p) => p.name === deck);
if (!pair) { console.error(`no deck named ${deck}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
const arity = ligatureArity(doc.asPDF());
const p = Number(pageArg) - 1;
const page = doc.loadPage(p);

const count = (s) => [...s].filter((c) => c === CH).length;

// 1. the raw walk, no repairs, no grouping
const raw = [];
page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces")
  .walk({ onChar(c, origin) { raw.push({ c, x: origin[0], y: origin[1] }); } });

// 2. after the repairs and groupAtomicUnits
const glyphs = extractGlyphs(page, arity);

// 3. after line/block assembly
const blocks = buildLines(glyphs);
const inBlocks = blocks.flatMap((b) => b.glyphs);

// 4. after withSpaces + visualToLogical
const texts = blocks.map((b) => blockText(b, blockIsRtl(b)));

const rows = [
  ["raw walk", raw.length, count(raw.map((g) => g.c).join(""))],
  ["extractGlyphs", glyphs.length, count(glyphs.map((g) => g.c).join(""))],
  ["buildLines", inBlocks.length, count(inBlocks.map((g) => g.c).join(""))],
  ["blockText", texts.join("").length, count(texts.join(""))],
];

console.log(`${deck} page ${pageArg}   counting ${JSON.stringify(CH)}\n`);
console.log(`  stage             glyphs/chars   ${JSON.stringify(CH)}`);
for (const [name, n, c] of rows) console.log(`  ${name.padEnd(16)} ${String(n).padStart(10)}   ${String(c).padStart(4)}`);

// Truth for the page, so the scorer's own view is on the same table.
const slides = loadSlides(pair.html);
const pageTexts = [];
for (let i = 0; i < doc.countPages(); i++) {
  pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(i), arity)).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
}
const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
const align = alignPagesToSlides(pageTexts, slideText);
if (align[p] >= 0) {
  console.log(`  ${"truth (the slide)".padEnd(16)} ${String(slideText[align[p]].length).padStart(10)}   ${String(count(slideText[align[p]])).padStart(4)}`);
}

// Where a stage loses one, name it. Compare the raw set against the block set by
// position, which is enough when the counts differ by a handful.
if (rows[0][2] !== rows[2][2]) {
  const seen = inBlocks.filter((g) => g.c === CH).map((g) => `${g.x.toFixed(1)},${g.y.toFixed(1)}`);
  const lost = raw.filter((g) => g.c === CH && !seen.includes(`${g.x.toFixed(1)},${g.y.toFixed(1)}`));
  console.log(`\n  ${lost.length} raw occurrence(s) have no block glyph at the same position:`);
  for (const g of lost.slice(0, 12)) console.log(`    x ${g.x.toFixed(2)}  y ${g.y.toFixed(2)}`);
}
