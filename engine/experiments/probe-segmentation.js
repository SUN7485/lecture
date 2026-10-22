/**
 * What IS the "no confident match" bucket, really?
 *
 * Its name is a guess, and KNOWN_ISSUES records that a previous fix was built on
 * that guess and failed: measured on chapter 1, only 6 of 104 were actually
 * "right text, wrong boundaries". This re-measures the class over all 28 decks
 * and splits it by the question that decides what to build:
 *
 *   is the TEXT right and only the boundary wrong  -> a segmentation fix helps
 *   is the TEXT itself wrong                       -> it is a character bug
 *                                                     wearing a boundary's name
 *
 * Whitespace is compared separately from characters, because a block that
 * differs only in spaces is a third thing again.
 *
 *   node experiments/probe-segmentation.js [samplesPerBucket]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 2);
const ARABIC = /[؀-ۿ]/;
const LATIN_OR_DIGIT = /[A-Za-z0-9]/;

const strip = (s) => s.replace(/\s+/g, "");

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

const buckets = new Map();
const samples = new Map();
const bump = (k, s) => {
  buckets.set(k, (buckets.get(k) ?? 0) + 1);
  const list = samples.get(k) ?? [];
  if (list.length < SAMPLES) { list.push(s); samples.set(k, list); }
};

let blocks = 0, verbatim = 0, unmatched = 0;

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);

  // Page N is not always slide N. Indexing `slides[p]` scored two whole decks
  // against the wrong text and produced the numbers this file was written to
  // correct — see truthForPages.
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p))).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truthAll = slideText[align[p]];
    const truthStripped = strip(truthAll);
    // The SOURCE's own line boundaries, which is what a boundary fault is
    // measured against.
    const truthLines = slides[align[p]].split("\n").map(normalize).filter(Boolean);

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      blocks++;
      if (truthAll.includes(got)) { verbatim++; continue; }

      // Reproduce categorize-misses' anchor test, so this measures the SAME set.
      const anchors = [got.slice(0, 12), got.slice(-12)];
      let matched = false;
      for (const a of anchors) if (a.length >= 4 && truthAll.includes(a)) matched = true;
      if (matched) continue;               // handled by the character buckets
      unmatched++;

      const where = `${pair.name} p${p + 1}`;
      const show = `${where}\n      got   ${got.slice(0, 74)}`;

      // 1. The characters are all there; only whitespace differs.
      if (truthStripped.includes(strip(got))) { bump("SPACING only — characters are correct", show); continue; }

      // 2. The block spans a source line boundary, or is a piece of one. Test by
      //    similarity against the best single truth line, ignoring spaces.
      let best = "", bestScore = 0;
      for (const line of truthLines) {
        const s = lcs(strip(got), strip(line)) / Math.max(strip(got).length, strip(line).length, 1);
        if (s > bestScore) { bestScore = s; best = line; }
      }
      const detail = `${show}\n      near  ${best.slice(0, 74)}  (${(bestScore * 100).toFixed(0)}%)`;

      // 3. Direction: an arithmetic or Latin-led line is a known separate fault.
      const latinLed = LATIN_OR_DIGIT.test(got.trim()[0] ?? "") || !ARABIC.test(got);

      if (bestScore >= 0.9) bump("BOUNDARY — text right, block split/merged", detail);
      else if (bestScore >= 0.6 && latinLed) bump("LTR/arithmetic line, text partly wrong", detail);
      else if (bestScore >= 0.6) bump("Arabic line, text partly wrong", detail);
      else if (latinLed) bump("LTR/arithmetic line, no good match", detail);
      else bump("no good match at all — different text", detail);
    }
  }
}

console.log(`SEGMENTATION BUCKET — ${blocks} blocks, ${verbatim} verbatim, ${unmatched} with no anchor in truth`);
console.log("=".repeat(78));
for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(v).padStart(5)}  ${((v / unmatched) * 100).toFixed(1).padStart(5)}%  ${k}`);
  for (const s of samples.get(k) ?? []) console.log(`      ${s}`);
}
console.log("=".repeat(78));
console.log("A fix for block boundaries only helps the BOUNDARY row. The rest are");
console.log("character or direction faults that this bucket's name hides.");
