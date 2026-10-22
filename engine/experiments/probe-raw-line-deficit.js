/**
 * Was the character ever handed to us?
 *
 * The `DROPPED letter "ي"` bucket has been read two opposite ways in two days:
 * "a real deletion the document cannot see", and "the letter is not missing, it
 * is mis-ordered by us". Both were argued from ONE site. This asks the question
 * per block, over the whole bucket, and the answer decides which route is worth
 * building:
 *
 *   the RAW WALK for that line is already short   -> structured text never gave
 *                                                    it to us. The route is the
 *                                                    ligature arity work.
 *   the raw line has enough                       -> we lose it after the walk.
 *                                                    The route is assembly.
 *
 * The raw walk is taken with the SHIPPING options and compared per LINE, not per
 * page: a page total can be conserved while one line is short and another is
 * long, which is exactly the reading a page-level count cannot distinguish.
 *
 *   node experiments/probe-raw-line-deficit.js [--letter ي] [--show 10]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const LETTER = arg("letter", "ي");
const SHOW = Number(arg("show", 10));
/** A raw character belongs to this line if its baseline is within this (pt). */
const SAME_LINE = 3;
/** and to this block if its origin is inside the block's span, padded (pt). */
const PAD = 2;

function lcs(a, b) {
  const dp = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function alignToTruth(got, truthAll) {
  const anchors = [got.slice(0, 12),
    got.slice(Math.max(0, (got.length >> 1) - 6), (got.length >> 1) + 6), got.slice(-12)];
  const positions = new Set();
  for (const a of anchors) {
    if (a.length < 4) continue;
    for (let i = truthAll.indexOf(a); i !== -1; i = truthAll.indexOf(a, i + 1)) positions.add(i);
  }
  if (!positions.size) {
    const step = Math.max(4, got.length >> 2);
    for (let i = 0; i < truthAll.length; i += step) positions.add(i);
  }
  let best = "", bestScore = -1;
  for (const pos of positions) {
    for (const start of [pos, pos - (got.length >> 1), pos - got.length + 12]) {
      if (start < 0) continue;
      const win = truthAll.slice(start, start + got.length);
      const s = lcs(got, win) / Math.max(got.length, win.length, 1);
      if (s > bestScore) { bestScore = s; best = win; }
    }
  }
  return { truth: best, score: bestScore };
}

const countIn = (s, ch) => [...s].filter((c) => c === ch).length;

const cells = { neverHandedToUs: 0, lostAfterTheWalk: 0, ambiguous: 0 };
const samples = { neverHandedToUs: [], lostAfterTheWalk: [] };

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const arity = ligatureArity(doc.asPDF());
  const slides = loadSlides(pair.html);

  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p), arity)).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truthAll = slideText[align[p]];
    const page = doc.loadPage(p);

    const raw = [];
    page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces")
      .walk({ onChar(c, origin) { raw.push({ c, x: origin[0], y: origin[1] }); } });

    for (const block of buildLines(extractGlyphs(page, arity))) {
      const got = normalize(blockText(block, blockIsRtl(block)));
      if (!got || truthAll.includes(got)) continue;
      const { truth, score } = alignToTruth(got, truthAll);
      if (score < 0.75) continue;

      const want = countIn(truth, LETTER), have = countIn(got, LETTER);
      if (want <= have) continue;                       // not a deficit of this letter

      // What the raw walk holds for THIS block's line and span.
      const y = block.glyphs[0].y;
      const inLine = raw.filter((g) => Math.abs(g.y - y) < SAME_LINE &&
        g.x >= block.x0 - PAD && g.x <= block.x1 + PAD);
      const rawHas = countIn(inLine.map((g) => g.c).join(""), LETTER);

      const where = `${pair.name} p${p + 1} y=${y.toFixed(1)}`;
      const detail = `${where}   truth wants ${want}, we produced ${have}, the raw walk holds ${rawHas}` +
        `\n      got   ${got.slice(0, 88)}\n      truth ${truth.slice(0, 88)}`;

      if (rawHas < want) {
        cells.neverHandedToUs++;
        if (samples.neverHandedToUs.length < SHOW) samples.neverHandedToUs.push(detail);
      } else if (rawHas >= want) {
        cells.lostAfterTheWalk++;
        if (samples.lostAfterTheWalk.length < SHOW) samples.lostAfterTheWalk.push(detail);
      } else cells.ambiguous++;
    }
  }
}

const total = cells.neverHandedToUs + cells.lostAfterTheWalk + cells.ambiguous;
console.log(`blocks short of ${JSON.stringify(LETTER)} against their truth window: ${total}\n`);
console.log(`  ${String(cells.neverHandedToUs).padStart(4)}  the RAW WALK is already short — structured text never gave it to us`);
console.log(`  ${String(cells.lostAfterTheWalk).padStart(4)}  the raw line HAS it — we lose it after the walk`);
for (const [k, list] of Object.entries(samples)) {
  if (!list.length) continue;
  console.log(`\n${k}:`);
  for (const s of list) console.log(`  ${s}`);
}
