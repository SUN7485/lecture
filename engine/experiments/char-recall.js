/**
 * Character-level recall, for changes the block-level verbatim gate cannot see.
 *
 * A block is verbatim or it is not, so a repair that restores a real character
 * inside a block carrying a SECOND defect scores exactly zero — which is what
 * `repairUnmatchedGlyphs` does: `يفل` becomes `يفصل`, the truth is `يفصّل`, and
 * the block stays a miss. That is a genuine improvement the headline number is
 * blind to, and the honest way to justify keeping it is to measure it.
 *
 * Recall here is the longest common subsequence between the extracted block and
 * its best-matching truth line, over the truth's length: how much of what the
 * source says actually survived, regardless of what else went wrong.
 *
 * Usage: node experiments/char-recall.js
 *        NO_GLYPH_REPAIR=1 node experiments/char-recall.js   (the baseline)
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

/** LCS length, O(n*m) over two short strings. */
function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length];
}

/** The truth window that best matches this block, so recall is not diluted. */
function bestWindow(truth, got) {
  const at = truth.indexOf(got);
  if (at >= 0) return got;
  // Anchor on the longest word the block and the truth share, then take a window
  // of the block's own length around it.
  const words = got.split(/\s+/).filter((w) => w.length > 3).sort((a, b) => b.length - a.length);
  for (const w of words.slice(0, 6)) {
    const i = truth.indexOf(w);
    if (i < 0) continue;
    const start = Math.max(0, i - Math.floor(got.length / 2));
    return truth.slice(start, start + got.length + 8);
  }
  return "";
}

let truthChars = 0, matched = 0, blocks = 0, scored = 0;

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p)))
      .map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truth = slideText[align[p]];
    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      blocks++;
      const window = bestWindow(truth, got);
      if (!window) continue;
      scored++;
      truthChars += got.length;
      matched += lcs(got, window);
    }
  }
}

console.log(`blocks ${blocks} · scored ${scored}`);
console.log(`characters compared : ${truthChars}`);
console.log(`characters matching : ${matched}`);
console.log(`character recall    : ${((matched / truthChars) * 100).toFixed(3)}%`);
