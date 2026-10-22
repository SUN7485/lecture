/**
 * Is `DROPPED letter "ي"` a deletion, or another transposition in disguise?
 *
 * The bucket directly above it, `DROPPED letter "ل"`, was a lam-alef ligature
 * emitted backwards for the entire life of this project — a first-divergence
 * classifier reports a SWAP as a deletion every time. `ي` is now the largest
 * single-letter bucket left (65 blocks), so the same question has to be asked
 * before anyone builds a recovery for it.
 *
 * This prints the got/truth PAIR around the divergence for every member of the
 * bucket, which is the only thing that settles it — and counts how many are
 * explained by a pure transposition rather than a missing character.
 *
 * Usage: node experiments/probe-ya-bucket.js [letter] [--show N]
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const LETTER = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "ي";
const SHOW = Number(process.argv[process.argv.indexOf("--show") + 1]) || 20;

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

let inBucket = 0, transposed = 0, sameMultiset = 0, deviceKnows = 0, deviceSilent = 0;
const shapes = new Map();
const rows = [];

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
      if (!got || truth.includes(got)) continue;

      const { best, bestScore } = alignToTruth(got, truth);
      if (bestScore < 0.35) continue;

      let d = 0;
      while (d < got.length && d < best.length && got[d] === best[d]) d++;
      // The bucket's own membership test, straight from the classifier.
      if (!(got[d] === best[d + 1] && best[d] === LETTER)) continue;
      inBucket++;

      // A TRANSPOSITION: the expected letter turns up one place later in ours.
      const isSwap = got[d] === best[d + 1] && got[d + 1] === best[d];
      if (isSwap) transposed++;

      // Weaker but broader: do both windows carry the same characters, just in
      // a different order? Then nothing was dropped anywhere in the window.
      const w = 8;
      const a = [...got.slice(Math.max(0, d - 2), d + w)].sort().join("");
      const b = [...best.slice(Math.max(0, d - 2), d + w)].sort().join("");
      if (a === b) sameMultiset++;

      const shape = `${best[d - 1] ?? "^"}${best[d]}${best[d + 1] ?? "$"}  ->  ${got[d - 1] ?? "^"}${got[d]}${got[d + 1] ?? "$"}`;
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);

      // Does the PAGE know a character is missing here? `charactersMissing` is
      // the device's own count and is independent of the truth comparison, so it
      // says whether a repair could ever have evidence to work from.
      if (o.charactersMissing > 0) deviceKnows++;
      else deviceSilent++;

      if (rows.length < SHOW) {
        rows.push(`${pair.name} p${i + 1}${isSwap ? "  [SWAP]" : ""}`
          + `\n      got   …${got.slice(Math.max(0, d - 14), d + 14)}…`
          + `\n      truth …${best.slice(Math.max(0, d - 14), d + 14)}…`);
      }
    }
  }
}

console.log(`bucket  DROPPED letter "${LETTER}"  : ${inBucket} blocks`);
console.log(`  a clean TRANSPOSITION           : ${transposed}`);
console.log(`  same characters, order differs  : ${sameMultiset}`);
console.log(`  genuinely one character short   : ${inBucket - sameMultiset}`);
console.log(`  the DEVICE counts it as missing : ${deviceKnows}   <- a repair could have evidence`);
console.log(`  the device is silent about it   : ${deviceSilent}   <- nothing to work from\n`);
console.log("shapes around the divergence (truth -> got):");
for (const [s, n] of [...shapes].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(4)}  ${s}`);
}
console.log("\nsamples:");
for (const r of rows) console.log(`  ${r}`);
