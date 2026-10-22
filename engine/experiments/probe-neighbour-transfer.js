/**
 * Did the missing character land in the BLOCK NEXT DOOR?
 *
 * The hypothesis: a character whose quad sits a little off the baseline (a
 * ligature component, a glyph under a shadda) is filed on an adjacent row by
 * `buildLines` and absorbed into a neighbouring block. `mergeOrphanFragments`
 * only rescues fragments narrower than 2pt, so a character swallowed by a wide
 * neighbour sails past it. If that is what happens, this is line ASSIGNMENT and
 * the fix is upstream of any repair.
 *
 * "A ي exists nearby" is not evidence — every Arabic line has one. This tests a
 * coupled TRANSACTION instead:
 *
 *   missing(A) = truth(A) - got(A)     as a multiset
 *   surplus(B) = got(B) - truth(B)     as a multiset
 *   the same character must be in BOTH, and moving one occurrence of it from B
 *   to A must REDUCE the combined edit distance of the two blocks.
 *
 * A healthy control runs the identical test on blocks that already match truth.
 * If the control fires at a similar rate, the test is measuring coincidence.
 *
 *   node experiments/probe-neighbour-transfer.js [--letter ي] [--show 12] [--find <substring>]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const LETTER = arg("letter", null);
const SHOW = Number(arg("show", 12));
const FIND = arg("find", null);

/** Levenshtein, capped in size because blocks are one line of text. */
function edit(a, b) {
  if (a === b) return 0;
  const prev = new Uint16Array(b.length + 1);
  const cur = new Uint16Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev.set(cur);
  }
  return prev[b.length];
}

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

/** Best same-length window of the slide text for this block. */
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

const bag = (s) => {
  const m = new Map();
  for (const c of s.replace(/\s+/g, "")) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};
/** Characters in `a` that `b` does not have enough of. */
const short = (a, b) => {
  const out = new Map();
  for (const [c, n] of a) {
    const d = n - (b.get(c) ?? 0);
    if (d > 0) out.set(c, d);
  }
  return out;
};

/** Blocks that could plausibly have stolen from this one: same page, near baseline. */
function neighbours(all, i) {
  const a = all[i];
  return all.filter((b, j) => {
    if (j === i) return false;
    const dy = Math.abs(b.block.y - a.block.y);
    if (dy > a.block.size * 3) return false;                 // the row above or below
    const overlap = Math.min(a.block.x1, b.block.x1) - Math.max(a.block.x0, b.block.x0);
    return overlap > -a.block.size * 4;                      // same column, or touching it
  });
}

const stats = { miss: 0, control: 0, missMatched: 0, controlMatched: 0, byChar: new Map() };
const samples = [];

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

    // Every block on the page, with its own truth window, once.
    const all = [];
    for (const block of buildLines(extractGlyphs(doc.loadPage(p), arity))) {
      const got = normalize(blockText(block, blockIsRtl(block)));
      if (!got) continue;
      const verbatim = truthAll.includes(got);
      const { truth, score } = verbatim ? { truth: got, score: 1 } : alignToTruth(got, truthAll);
      all.push({ block, got, truth, score, verbatim });
    }

    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      if (FIND && !a.got.includes(FIND)) continue;
      if (!FIND && !a.verbatim && a.score < 0.75) continue;    // no usable truth window
      const missing = short(bag(a.truth), bag(a.got));
      if (LETTER && !missing.has(LETTER)) { if (!FIND) continue; }
      const isMiss = !a.verbatim && missing.size > 0;
      if (isMiss) stats.miss++; else stats.control++;
      if (!missing.size) continue;

      const before = edit(a.got, a.truth);
      let found = null;
      for (const b of neighbours(all, i)) {
        const surplus = short(bag(b.got), bag(b.truth));
        for (const [c] of missing) {
          if (!surplus.has(c)) continue;
          // Does moving one occurrence of c from B to A actually help?
          const bAfter = b.got.replace(c, "");
          let bestA = Infinity, at = -1;
          for (let k = 0; k <= a.got.length; k++) {
            const cand = a.got.slice(0, k) + c + a.got.slice(k);
            const d = edit(cand, a.truth);
            if (d < bestA) { bestA = d; at = k; }
          }
          const gain = (before + edit(b.got, b.truth)) - (bestA + edit(bAfter, b.truth));
          if (gain > 0) { found = { c, b, gain, at }; break; }
        }
        if (found) break;
      }

      if (found) {
        if (isMiss) stats.missMatched++; else stats.controlMatched++;
        stats.byChar.set(found.c, (stats.byChar.get(found.c) ?? 0) + 1);
      }
      if ((FIND || (isMiss && found)) && samples.length < SHOW) {
        samples.push(`${pair.name} p${p + 1} y=${a.block.y.toFixed(1)}` +
          `\n      missing ${JSON.stringify([...missing.keys()].join(""))}` +
          `\n      got     ${a.got.slice(0, 92)}` +
          `\n      truth   ${a.truth.slice(0, 92)}` +
          (found
            ? `\n      -> ${JSON.stringify(found.c)} is SURPLUS in the block at y=${found.b.block.y.toFixed(1)}, gain ${found.gain}` +
              `\n         that block: ${found.b.got.slice(0, 86)}`
            : `\n      -> no neighbour holds it as a surplus`));
      }
    }
  }
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : "0.0") + "%";
console.log(`blocks tested with a real deficit : ${stats.miss}`);
console.log(`  a neighbour holds it as surplus : ${stats.missMatched}  (${pct(stats.missMatched, stats.miss)})`);
console.log(`healthy control blocks            : ${stats.control}`);
console.log(`  same test fires anyway          : ${stats.controlMatched}  (${pct(stats.controlMatched, stats.control)})   <- coincidence rate`);
if (stats.byChar.size) {
  console.log(`\ncharacters transferred:`);
  for (const [c, n] of [...stats.byChar].sort((x, y) => y[1] - x[1]).slice(0, 12)) console.log(`  ${String(n).padStart(4)}  ${JSON.stringify(c)}`);
}
console.log();
for (const s of samples) console.log(`  ${s}`);
