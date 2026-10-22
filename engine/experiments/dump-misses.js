/**
 * Dump every non-verbatim block WITH the truth it should have matched, as JSONL.
 *
 * Every probe in this directory re-extracts the whole corpus (~2 minutes) to ask
 * one question about the misses. This does the extraction once and writes the
 * evidence to a file, so the questions afterwards cost nothing and every one of
 * them is asked against exactly the same set of blocks.
 *
 *   node experiments/dump-misses.js > misses.jsonl
 *
 * Fields: deck, page, key (the verbatim-set key), got, truth (best window),
 * score (0..1 similarity of that window), verbatim (always false).
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

function lcs(a, b) {
  const dp = Array(b.length + 1).fill(0);
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

/**
 * Best same-length window of the slide's text for this block.
 *
 * Anchors are exact substrings, which a damaged block may not have anywhere, so
 * a sliding fallback keeps the worst blocks in the evidence instead of dropping
 * exactly the cases a fix is meant to reach.
 */
function alignToTruth(got, truthAll) {
  const anchors = [got.slice(0, 12), got.slice(Math.max(0, (got.length >> 1) - 6), (got.length >> 1) + 6), got.slice(-12)];
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
      const win = truthAll.slice(start, start + got.length + 8);
      const s = lcs(got, win) / Math.max(got.length, win.length, 1);
      if (s > bestScore) { bestScore = s; best = win; }
    }
  }
  return { best, bestScore };
}

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
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got || truthAll.includes(got)) continue;
      const { best, bestScore } = alignToTruth(got, truthAll);
      console.log(JSON.stringify({
        deck: pair.name,
        page: p + 1,
        key: `${pair.name} p${p + 1} y=${b.y.toFixed(1)} x1=${b.x1.toFixed(1)}`,
        got,
        truth: best,
        score: Number(bestScore.toFixed(3)),
      }));
    }
  }
}
