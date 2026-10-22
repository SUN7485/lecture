/**
 * Categorise every failing block by WHAT differs from ground truth, so fixes
 * are prioritised by frequency instead of by whichever example was noticed.
 *
 * For each miss we find the most similar truth line and report the first
 * divergence, then bucket the misses by signature.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { ligatureArity } from "../src/extract/cff-names.js";

// The whole corpus, every chapter, discovered rather than listed — the hardcoded
// six were chapter 1 only, which is 6 of the 28 decks that have ground truth.
// Pass a deck name to score just that one.
const PAIRS = findPairs().filter((p) => !process.argv[2] || p.name === process.argv[2]);
if (!PAIRS.length) {
  console.error(process.argv[2] ? `no ground-truth pair named ${process.argv[2]}` : "no corpus found");
  process.exit(2);
}

const isMark = (ch) => /[\u064B-\u0655\u0670\u06D6-\u06ED]/.test(ch);

/** Longest common subsequence length — cheap similarity for short strings. */
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

/** Classify one miss by its first divergence from the closest truth line. */
function classify(got, truth) {
  let i = 0;
  while (i < got.length && i < truth.length && got[i] === truth[i]) i++;
  const g = got.slice(i, i + 6), t = truth.slice(i, i + 6);

  if (i >= got.length && i < truth.length) return ["truncated (block shorter than source)", g, t];
  if (i >= truth.length) return ["overrun (block longer than source)", g, t];

  // A character present in truth but absent from ours at this point.
  if (got[i] === truth[i + 1] && truth[i]) {
    return [isMark(truth[i]) ? "DROPPED combining mark" : `DROPPED letter "${truth[i]}"`, g, t];
  }
  if (got[i + 1] === truth[i]) return [`EXTRA char "${got[i]}"`, g, t];
  if (got[i] === truth[i + 1] && got[i + 1] === truth[i]) return ["swapped pair", g, t];
  if (isMark(got[i]) || isMark(truth[i])) return ["mark misplaced", g, t];
  if (got[i] === " " || truth[i] === " ") return ["space misplaced", g, t];
  if (/[0-9]/.test(got[i]) || /[0-9]/.test(truth[i])) return ["digit wrong", g, t];
  if (/[()]/.test(got[i]) || /[()]/.test(truth[i])) return ["paren wrong", g, t];
  return ["other substitution", g, t];
}

/**
 * Locate the region of the full slide text a block corresponds to.
 *
 * Matching against individual HTML lines is wrong: the PDF wraps at different
 * points than the source markup, so a correct block routinely spans two truth
 * lines and scores ~50% against either. We anchor on a distinctive fragment of
 * the block, then compare a same-length window of the joined truth.
 */
function alignToTruth(got, truthAll) {
  const anchors = [got.slice(0, 12), got.slice(Math.max(0, (got.length >> 1) - 6), (got.length >> 1) + 6), got.slice(-12)];
  const positions = new Set();
  for (const a of anchors) {
    if (a.length < 4) continue;
    for (let i = truthAll.indexOf(a); i !== -1; i = truthAll.indexOf(a, i + 1)) positions.add(i);
  }
  let best = "", bestScore = -1;
  for (const pos of positions) {
    for (const start of [pos, pos - (got.length >> 1), pos - got.length + 12]) {
      if (start < 0) continue;
      const win = truthAll.slice(start, start + got.length + 8);
      const s = lcs(got, win) / Math.max(got.length, win.length);
      if (s > bestScore) { bestScore = s; best = win; }
    }
  }
  return { best, bestScore };
}

const buckets = new Map();
const samples = new Map();
let total = 0, hits = 0, unscored = 0;

for (const pair of PAIRS) {
  const name = pair.name;
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  // The font's own ligature names, so this harness sees exactly what
  // modelFromPdf sees. Without it the gate is vacuous for any change that
  // reaches extraction through the arity map.
  const arity = ligatureArity(doc.asPDF());
  const slides = loadSlides(pair.html);

  // Page N is not always slide N — see alignPagesToSlides. Pages with no truth
  // behind them are counted and reported, never scored as if they were misses.
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p), arity)).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    const si = align[p];
    if (si < 0) { unscored++; continue; }
    const truthLines = slides[si].split("\n").map(normalize).filter(Boolean);
    const truthAll = slideText[si];

    for (const b of buildLines(extractGlyphs(doc.loadPage(p), arity))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      total++;
      if (truthAll.includes(got)) { hits++; continue; }

      const { best, bestScore } = alignToTruth(got, truthAll);
      // Below this the "closest" line is a different sentence entirely, so any
      // character-level verdict would be noise. Those are segmentation misses:
      // our block boundaries do not line up with the source's, which is a
      // different problem from getting the characters wrong.
      if (bestScore < 0.65) {
        buckets.set("no confident match (block segmentation)", (buckets.get("no confident match (block segmentation)") ?? 0) + 1);
        if (!samples.has("no confident match (block segmentation)")) {
          samples.set("no confident match (block segmentation)", `${name} p${p + 1}\n      got   ${got.slice(0, 60)}\n      near  ${best.slice(0, 60)} (${(bestScore * 100).toFixed(0)}%)`);
        }
        continue;
      }
      const [kind, g, t] = classify(got, best);
      buckets.set(kind, (buckets.get(kind) ?? 0) + 1);
      if (!samples.has(kind)) samples.set(kind, `${name} p${p + 1}\n      got   ...${g}\n      truth ...${t}`);
    }
  }
}

console.log(`pages with no HTML slide behind them (not scored): ${unscored}`);
console.log(`blocks: ${total}   verbatim: ${hits} (${((hits / total) * 100).toFixed(2)}%)   misses: ${total - hits}\n`);
console.log("MISS CAUSES BY FREQUENCY");
console.log("-".repeat(64));
for (const [kind, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${((n / (total - hits)) * 100).toFixed(1).padStart(5)}%  ${kind}`);
  console.log(`      ${samples.get(kind)}`);
}
