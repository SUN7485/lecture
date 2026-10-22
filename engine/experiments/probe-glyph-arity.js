/**
 * Which glyph IDs stand for MORE THAN ONE character?
 *
 * `owedOf` knows exactly one family — the lam-alef presentation forms — so every
 * other multi-character glyph owes 1, the deficit detector sees no shortfall,
 * and 65 blocks lose a `ي` with nothing in the document able to say so.
 *
 * At a known site the answer is visible by eye: glyph 612 carries `لي`, is
 * unnamed (U+FFFD), and has an advance of 0.872 em where a plain lam is 0.271
 * and the widest NAMED letter in the same font is 0.618.
 *
 * Two questions, in order:
 *
 *  1. Can the corpus tell us a glyph's arity WITHOUT looking at advances? On a
 *     block that is verbatim, every glyph provably owes what structured text
 *     supplied, so any glyph seen there is confirmed single. A glyph that never
 *     appears on any verbatim block is a suspect.
 *  2. Does the ADVANCE agree? If the set inferred in (1) is also the set of
 *     outlier-wide glyphs, the two independent signals confirm each other and
 *     the advance becomes usable on fonts this corpus has never seen.
 *
 * Usage: node experiments/probe-glyph-arity.js [--show N]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SHOW = Number(process.argv[process.argv.indexOf("--show") + 1]) || 25;

/** A device walk that keeps the glyph ID and the advance in em. */
function deviceGlyphsWithId(page) {
  const out = [];
  const device = new mupdf.Device({
    fillText(text, ctm) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          const x = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4];
          const y = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5];
          out.push({ x, y, glyph, unicode, font: font.getName(), advanceEm: font.advanceGlyph(glyph) });
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

const key = (d) => `${d.font}#${d.glyph}`;
/** glyph -> { advanceEm, unicode, onVerbatim, onShort, total } */
const stats = new Map();

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
    const blocks = buildLines(extractGlyphs(page));

    for (const b of blocks) {
      if (!b.glyphs?.length) continue;
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      const verbatim = truth.includes(got);

      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      const mine = devs.filter((d) => Math.abs(d.y - b.y) <= 1.5 && d.x >= x0 - 1 && d.x <= x1 + 1);
      if (!mine.length) continue;

      for (const d of mine) {
        const k = key(d);
        const s = stats.get(k) ?? { advanceEm: d.advanceEm, unicode: d.unicode, font: d.font,
          glyph: d.glyph, onVerbatim: 0, onMiss: 0, total: 0 };
        s.total++;
        if (verbatim) s.onVerbatim++; else s.onMiss++;
        stats.set(k, s);
      }
    }
  }
}

const all = [...stats.values()];
// A glyph seen on a block that came out EXACTLY right cannot be swallowing a
// character on that block, so it is confirmed single-arity.
const confirmedSingle = all.filter((s) => s.onVerbatim > 0);
const suspects = all.filter((s) => s.onVerbatim === 0);

const widest = Math.max(...confirmedSingle.map((s) => s.advanceEm));
const namedWidest = Math.max(...confirmedSingle.filter((s) => s.unicode !== 0xfffd).map((s) => s.advanceEm));

console.log(`distinct glyphs in the corpus     : ${all.length}`);
console.log(`  seen on at least one VERBATIM block (confirmed single) : ${confirmedSingle.length}`);
console.log(`  never seen on a verbatim block  (suspect)             : ${suspects.length}\n`);
console.log(`widest confirmed-single advance   : ${widest.toFixed(3)} em`);
console.log(`widest NAMED confirmed-single     : ${namedWidest.toFixed(3)} em\n`);

console.log("suspects, widest first (never on a verbatim block):");
console.log("   adv/em  unicode   seen  font#glyph");
for (const s of suspects.sort((a, b) => b.advanceEm - a.advanceEm).slice(0, SHOW)) {
  const u = s.unicode === 0xfffd ? "U+FFFD" : `${String.fromCodePoint(s.unicode)} U+${s.unicode.toString(16).toUpperCase()}`;
  console.log(`   ${s.advanceEm.toFixed(3)}  ${u.padEnd(9)} ${String(s.total).padStart(5)}  ${s.font.replace(/^[A-Z]{6}\+/, "")}#${s.glyph}`);
}

// How much of the advance range do the two sets share? If the suspects are all
// above every confirmed single, one threshold separates them.
const overlap = suspects.filter((s) => s.advanceEm <= widest).length;
console.log(`\nsuspects whose advance is within the confirmed-single range: ${overlap}/${suspects.length}`);
console.log(`  -> a single advance threshold ${overlap ? "CANNOT" : "CAN"} separate them`);
