/**
 * What is still wrong in the deck the USER opens.
 *
 * `categorize-misses.js` classifies raw extraction, and its top bucket is now a
 * defect `convert` repairs on the way out — the first sample it prints is a
 * stranded fathatan, which never reaches a slide any more. Attacking that list
 * means working on problems nobody has.
 *
 * This applies DEFAULT_REPAIRS first and classifies what survives, so the
 * biggest bucket here is the biggest bucket the user actually sees.
 *
 * Usage: node experiments/delivered-misses.js [--show N]
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = Number(process.argv[process.argv.indexOf("--show") + 1]) || 3;
const isMark = (c) => c && /[ً-ْٰ]/.test(c);

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

/** Classify one miss by its first divergence. Same rules as categorize-misses. */
function classify(got, truth) {
  let i = 0;
  while (i < got.length && i < truth.length && got[i] === truth[i]) i++;
  const g = got.slice(i, i + 8), t = truth.slice(i, i + 8);
  if (i >= got.length && i < truth.length) return ["truncated (block shorter than source)", g, t];
  if (i >= truth.length) return ["overrun (block longer than source)", g, t];
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

function alignToTruth(got, truthAll) {
  const anchors = [got.slice(0, 12),
    got.slice(Math.max(0, (got.length >> 1) - 6), (got.length >> 1) + 6), got.slice(-12)];
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
let blocks = 0, misses = 0;

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  const slideText = loadSlides(pair.html).map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const [i, page] of model.pages.entries()) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    for (const o of page.objects) {
      if (o.type !== "text" || !o.text) continue;
      const got = normalize(o.text);
      if (!got) continue;
      blocks++;
      if (truth.includes(got)) continue;
      misses++;

      const { best, bestScore } = alignToTruth(got, truth);
      const [bucket, g, t] = bestScore < 0.35
        ? ["no confident match (block segmentation)", got.slice(0, 30), ""]
        : classify(got, best);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
      const s = samples.get(bucket) ?? [];
      if (s.length < SHOW) {
        s.push(`${pair.name} p${i + 1}\n        got   …${g}…\n        truth …${t}…`);
        samples.set(bucket, s);
      }
    }
  }
}

console.log(`DELIVERED (after ${DEFAULT_REPAIRS.join(" + ")})`);
console.log(`blocks ${blocks}   verbatim ${blocks - misses} (${(((blocks - misses) / blocks) * 100).toFixed(2)}%)   misses ${misses}\n`);
console.log("MISS CAUSES BY FREQUENCY");
console.log("-".repeat(64));
for (const [b, n] of [...buckets].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${((n / misses) * 100).toFixed(1).padStart(5)}%  ${b}`);
  for (const s of samples.get(b) ?? []) console.log(`      ${s}`);
}
