/**
 * How many blocks are STRANDED STRIPS that belong to the line below?
 *
 * A shadda raises a glyph's bounding box, `buildLines` files it on its own
 * baseline, and it becomes a block of its own. `mergeOrphanFragments` rescues
 * those only while they are narrower than 2pt, so a strip carrying several
 * characters — measured, `Chp1-Lec6-2` p17 holds `يّ تُ دَّ` 8pt above the line
 * that is missing exactly `يُّدَ` — sails straight past it.
 *
 * This sizes that population before anyone widens a threshold. A strip counts
 * only when the line it sits over is ALSO short of exactly the characters the
 * strip holds, which is what separates a stranded fragment from an ordinary
 * short line.
 *
 *   node experiments/probe-orphan-strips.js [--show 10]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, isCombiningMark } from "../src/extract/glyphs.js";
import { ligatureArity } from "../src/extract/cff-names.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SHOW = Number(arg("show", 10));

const bag = (s) => {
  const m = new Map();
  for (const c of s.replace(/\s+/g, "")) m.set(c, (m.get(c) ?? 0) + 1);
  return m;
};
const shortOf = (want, have) => {
  const out = [];
  for (const [c, n] of want) for (let k = 0; k < n - (have.get(c) ?? 0); k++) out.push(c);
  return out;
};

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
      const win = truthAll.slice(start, start + got.length);
      const s = lcs(got, win) / Math.max(got.length, win.length, 1);
      if (s > bestScore) { bestScore = s; best = win; }
    }
  }
  return { truth: best, score: bestScore };
}

let strips = 0, stripsExplainingAMiss = 0, charsRecoverable = 0;
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

    const all = buildLines(extractGlyphs(doc.loadPage(p), arity))
      .map((block) => ({ block, got: normalize(blockText(block, blockIsRtl(block))) }))
      .filter((b) => b.got);

    for (const s of all) {
      // A strip: mostly combining marks, or very few characters, sitting ABOVE
      // another block whose span it overlaps.
      const marks = s.block.glyphs.filter((g) => isCombiningMark(g.c)).length;
      const isStrip = marks > 0 && marks >= s.block.glyphs.length / 3 && s.got.length <= 12;
      if (!isStrip) continue;

      const host = all.find((h) => h !== s &&
        h.block.y > s.block.y && h.block.y - s.block.y <= s.block.size * 2.5 &&
        Math.min(h.block.x1, s.block.x1) - Math.max(h.block.x0, s.block.x0) > 0);
      if (!host) continue;
      strips++;

      if (truthAll.includes(host.got)) continue;             // the host is fine
      const { truth, score } = alignToTruth(host.got, truthAll);
      if (score < 0.7) continue;
      const missing = shortOf(bag(truth), bag(host.got));
      const held = bag(s.got);
      const overlap = missing.filter((c) => held.has(c)).length;
      if (!overlap) continue;

      stripsExplainingAMiss++;
      charsRecoverable += overlap;
      if (samples.length < SHOW) {
        samples.push(`${pair.name} p${p + 1}  strip y=${s.block.y.toFixed(1)} holds ${JSON.stringify(s.got)}` +
          `\n      host y=${host.block.y.toFixed(1)} is missing ${JSON.stringify(missing.join(""))}` +
          `\n      host  ${host.got.slice(0, 84)}\n      truth ${truth.slice(0, 84)}`);
      }
    }
  }
}

console.log(`strips (mark-heavy blocks sitting over another block): ${strips}`);
console.log(`  whose host line is short of characters the strip holds: ${stripsExplainingAMiss}`);
console.log(`  characters that would come back: ${charsRecoverable}`);
console.log();
for (const s of samples) console.log(`  ${s}`);
