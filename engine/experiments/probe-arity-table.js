/**
 * How BIG would a glyph->arity table have to be?
 *
 * Three routes from the document alone are closed (probe-glyph-arity*.js,
 * probe-glyph-selfarity.js): a wide glyph is not necessarily a ligature, arity
 * is not learnable from "never on a verbatim block", and it cannot be
 * self-calibrated because the loss is 100% consistent per glyph — 60 of 60
 * occurrences of the `لي` glyph yield one character, never two.
 *
 * What remains is external knowledge: the font's own GSUB tables (a real
 * fontkit-class dependency), or a table learned ONCE against ground truth and
 * shipped. This measures the second option's size and reach before anyone builds
 * either — if a handful of glyphs account for most of the loss, the table is
 * trivial; if it is hundreds, only the font tables will do.
 *
 * Method: for each block short of its aligned truth, find the device glyph whose
 * advance covers the position where structured text ran out of characters. Those
 * glyphs are the ones owing more than they are credited with.
 *
 * Usage: node experiments/probe-arity-table.js [--show N]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = Number(process.argv[process.argv.indexOf("--show") + 1]) || 20;
const SPAN_EPS = 0.35;

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

function deviceGlyphsWithId(page) {
  const out = [];
  const device = new mupdf.Device({
    fillText(text, ctm) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          const em = Math.hypot(ctm[0] * trm[0] + ctm[2] * trm[1], ctm[1] * trm[0] + ctm[3] * trm[1]);
          out.push({
            x: ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4],
            y: ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5],
            glyph, unicode,
            font: font.getName().replace(/^[A-Z]{6}\+/, ""),
            advance: font.advanceGlyph(glyph) * em,
          });
        },
      });
    },
    fillPath() {}, strokePath() {}, clipPath() {}, clipStrokePath() {},
    strokeText() {}, clipText() {}, clipStrokeText() {}, ignoreText() {},
    fillShade() {}, fillImage() {}, fillImageMask() {}, clipImageMask() {},
    popClip() {}, beginMask() {}, endMask() {}, beginGroup() {}, endGroup() {},
    beginTile() { return 0; }, endTile() {}, close() {}, drop() {},
  });
  page.run(device, mupdf.Matrix.identity);
  device.close();
  return out;
}

/** Device glyphs covering exactly ONE stext glyph, on blocks short of truth. */
const blame = new Map();
let shortBlocks = 0, blamed = 0;

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
    const page = doc.loadPage(p);
    const devs = deviceGlyphsWithId(page);

    for (const b of buildLines(extractGlyphs(page))) {
      if (!b.glyphs?.length) continue;
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got || truth.includes(got)) continue;
      const { best, bestScore } = alignToTruth(got, truth);
      if (bestScore < 0.35) continue;
      // Only blocks whose text is truth MINUS some characters. `best` is a
      // fixed-length window (got.length + 8), so its length carries no
      // information — comparing lengths gave a deficit of ~8 on every block and
      // filtered all of them out. A subsequence test is the honest one: if every
      // character of `got` appears in the truth window in order, then nothing was
      // substituted or reordered and the only fault is deletion.
      if (lcs(got, best) !== got.length) continue;
      shortBlocks++;

      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      for (const d of devs) {
        if (Math.abs(d.y - b.y) > 1.5 || d.x < x0 - 1 || d.x > x1 + 1) continue;
        if (d.advance <= 0 || d.unicode !== 0xfffd) continue;
        const inside = b.glyphs.filter((g) =>
          g.x0 >= d.x - SPAN_EPS && g.x0 < d.x + d.advance - SPAN_EPS).length;
        if (inside !== 1) continue;
        const k = `${d.font}#${d.glyph}`;
        blame.set(k, (blame.get(k) ?? 0) + 1);
        blamed++;
      }
    }
  }
}

const ranked = [...blame].sort((a, b) => b[1] - a[1]);
const total = ranked.reduce((n, [, c]) => n + c, 0);
console.log(`blocks short of truth by 1-3 characters : ${shortBlocks}`);
console.log(`unnamed glyphs covering one stext glyph  : ${blamed} occurrences over ${ranked.length} distinct glyphs\n`);

let run = 0;
console.log("most-blamed glyphs (cumulative share of all suspect occurrences):");
for (const [k, c] of ranked.slice(0, SHOW)) {
  run += c;
  console.log(`  ${String(c).padStart(5)}  ${((run / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
for (const frac of [0.5, 0.8, 0.9]) {
  let acc = 0, n = 0;
  for (const [, c] of ranked) { acc += c; n++; if (acc / total >= frac) break; }
  console.log(`\n  ${(frac * 100).toFixed(0)}% of suspect occurrences come from ${n} glyphs`);
}
