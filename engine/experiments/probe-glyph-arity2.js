/**
 * Per-FONT advance, and the one glyph whose arity is known by hand.
 *
 * The global version of this comparison is meaningless: the widest single
 * character in the corpus is 1.792 em, and it is a Type3 emoji. Arabic text
 * fonts and one-glyph emoji fonts do not share a scale, so the question has to
 * be asked inside a font.
 *
 * `LyonArabicTextLF-Bold#612` is the calibration point — it carries `لي` in
 * `التشغيلي`, is unnamed, and measures 0.872 em where a plain lam in the same
 * font is 0.271 and the widest NAMED letter is 0.618.
 *
 * Usage: node experiments/probe-glyph-arity2.js [font-substring]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const WANT = process.argv[2] ?? "";

function deviceGlyphsWithId(page) {
  const out = [];
  const device = new mupdf.Device({
    fillText(text, ctm) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          out.push({
            x: ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4],
            y: ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5],
            glyph, unicode,
            font: font.getName().replace(/^[A-Z]{6}\+/, ""),
            advanceEm: font.advanceGlyph(glyph),
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

/** font -> glyph -> {advanceEm, unicode, verbatim, miss} */
const byFont = new Map();

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
      if (!got) continue;
      const verbatim = truth.includes(got);
      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      for (const d of devs) {
        if (Math.abs(d.y - b.y) > 1.5 || d.x < x0 - 1 || d.x > x1 + 1) continue;
        if (!byFont.has(d.font)) byFont.set(d.font, new Map());
        const m = byFont.get(d.font);
        const s = m.get(d.glyph) ?? { advanceEm: d.advanceEm, unicode: d.unicode, verbatim: 0, miss: 0 };
        if (verbatim) s.verbatim++; else s.miss++;
        m.set(d.glyph, s);
      }
    }
  }
}

const fonts = [...byFont].filter(([f]) => !WANT || f.includes(WANT))
  .sort((a, b) => b[1].size - a[1].size);

for (const [font, glyphs] of fonts.slice(0, 6)) {
  const all = [...glyphs.entries()];
  // A glyph on a block that came out EXACTLY right cannot have swallowed a
  // character there, so it is proven single-arity.
  const single = all.filter(([, s]) => s.verbatim > 0);
  const suspect = all.filter(([, s]) => s.verbatim === 0);
  if (single.length < 10) continue;

  const maxSingle = Math.max(...single.map(([, s]) => s.advanceEm));
  const named = single.filter(([, s]) => s.unicode !== 0xfffd);
  const maxNamed = named.length ? Math.max(...named.map(([, s]) => s.advanceEm)) : 0;
  const above = suspect.filter(([, s]) => s.advanceEm > maxSingle).length;

  console.log(`\n${font}`);
  console.log(`  glyphs ${all.length}   proven single ${single.length}   suspect ${suspect.length}`);
  console.log(`  widest proven single : ${maxSingle.toFixed(3)} em`
    + (maxNamed ? `   (widest NAMED single ${maxNamed.toFixed(3)})` : ""));
  console.log(`  suspects wider than every proven single : ${above}`);

  // The calibration point, if this is its font.
  const cal = glyphs.get(612);
  if (cal) {
    console.log(`  >> glyph 612 (known to carry \`لي\`): adv ${cal.advanceEm.toFixed(3)} em, `
      + `seen on ${cal.verbatim} verbatim / ${cal.miss} miss blocks`);
  }
  const top = single.sort((a, b) => b[1].advanceEm - a[1].advanceEm).slice(0, 5)
    .map(([g, s]) => `g${g}:${s.advanceEm.toFixed(2)}${s.unicode !== 0xfffd ? "*" : ""}`).join(" ");
  console.log(`  widest proven singles: ${top}    (* = named by the font)`);
}
