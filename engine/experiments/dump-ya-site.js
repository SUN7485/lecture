/**
 * What do the two streams ACTUALLY contain where a `ي` goes missing?
 *
 * `التشغيلي` comes out `التشغلي` and the deficit detector is silent, which means
 * the device path also reports one glyph too few — `owedOf` sees no shortfall
 * because it only knows lam-alef presentation forms. Before theorising about
 * advances, this dumps both streams side by side at a known site, with the glyph
 * IDs, so the shape of the loss can be read rather than guessed.
 *
 * Usage: node experiments/dump-ya-site.js [word] [pdf] [page1based]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";

const WORD = process.argv[2] ?? "التشغلي";
const PDF = process.argv[3] ?? "C:/Users/mosun/Downloads/final lecs/chp.4/done/Chp4-Lec23-1.pdf";
const PAGE = Number(process.argv[4] ?? 7) - 1;

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const page = doc.loadPage(PAGE);

// The device walk again, but keeping the GLYPH ID — `deviceGlyphs` throws it
// away, and it is the only thing that identifies a shape inside the font.
const devs = [];
const device = new mupdf.Device({
  fillText(text, ctm) {
    text.walk({
      showGlyph(font, trm, glyph, unicode) {
        const x = ctm[0] * trm[4] + ctm[2] * trm[5] + ctm[4];
        const y = ctm[1] * trm[4] + ctm[3] * trm[5] + ctm[5];
        const em = Math.hypot(ctm[0] * trm[0] + ctm[2] * trm[1], ctm[1] * trm[0] + ctm[3] * trm[1]);
        devs.push({
          x, y, glyph, unicode, em,
          advance: font.advanceGlyph(glyph) * em,
          advanceEm: font.advanceGlyph(glyph),
          font: font.getName(),
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

const glyphs = extractGlyphs(page);
const blocks = buildLines(glyphs);

const hit = blocks.find((b) => blockText(b, blockIsRtl(b)).includes(WORD));
if (!hit) {
  console.log(`"${WORD}" not found on page ${PAGE + 1}. Blocks here:`);
  for (const b of blocks.slice(0, 12)) console.log("   " + blockText(b, blockIsRtl(b)).slice(0, 74));
  process.exit(1);
}

const text = blockText(hit, blockIsRtl(hit));
console.log(`block: ${text.slice(0, 90)}`);
console.log(`baseline y=${hit.y.toFixed(2)}\n`);

// Narrow to the word: structured-text glyphs are in visual order left to right.
const x0 = Math.min(...hit.glyphs.map((g) => g.x0));
const x1 = Math.max(...hit.glyphs.map((g) => g.x1));
const mine = devs.filter((d) => Math.abs(d.y - hit.y) <= 1.5 && d.x >= x0 - 1 && d.x <= x1 + 1)
  .sort((a, b) => a.x - b.x);
const stext = hit.glyphs.slice().sort((a, b) => a.x0 - b.x0);

console.log(`structured text : ${stext.length} glyphs`);
console.log(`device          : ${mine.length} glyphs\n`);

// Walk both by x so the columns line up on position.
console.log("      x     STEXT              DEVICE  glyph  unicode      adv    adv/em");
console.log("-".repeat(78));
const xs = [...new Set([...stext.map((g) => +g.x0.toFixed(1)), ...mine.map((d) => +d.x.toFixed(1))])]
  .sort((a, b) => a - b);
for (const x of xs) {
  const s = stext.find((g) => Math.abs(g.x0 - x) < 0.6);
  const d = mine.find((m) => Math.abs(m.x - x) < 0.6);
  const sc = s ? `${JSON.stringify(s.c)} U+${s.c.codePointAt(0).toString(16).toUpperCase()}` : "—";
  const dc = d
    ? `${d.unicode === 0xfffd ? "?" : JSON.stringify(String.fromCodePoint(d.unicode))}`
      + ` g${String(d.glyph).padEnd(5)} U+${d.unicode.toString(16).toUpperCase().padEnd(6)}`
      + ` ${d.advance.toFixed(2).padStart(6)}  ${d.advanceEm.toFixed(3)}`
    : "—";
  console.log(`  ${String(x).padStart(7)}   ${sc.padEnd(18)} ${dc}`);
}

const named = mine.filter((d) => d.unicode !== 0xfffd).length;
console.log(`\ndevice glyphs named by the font: ${named}/${mine.length}`);
console.log(`distinct fonts on this line    : ${[...new Set(mine.map((d) => d.font))].join(", ")}`);
