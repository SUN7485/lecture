/**
 * Does the DEVICE path (showGlyph) recover glyphs the STRUCTURED-TEXT path drops?
 *
 * stext gives characters through ToUnicode and silently omits a glyph with no
 * entry. showGlyph reports the glyph id and unicode separately, so it may see
 * glyphs stext never emits. If the counts differ, the fix for the dropped alef
 * is to extract via the Device rather than to repair after the fact.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");

const NOON = "\u0646", HAH = "\u062D", RAH = "\u0631", ALEF = "\u0627", FEH = "\u0641";
const CORE = NOON + HAH + RAH + ALEF + FEH;                 // "nhiraf"
const rev = (s) => [...s].reverse().join("");

let totalStext = 0, totalDevice = 0;

for (let p = 0; p < 21; p++) {
  const page = doc.loadPage(p);

  // --- structured text path (what we ship today) ---
  let stextCount = 0;
  page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces").walk({
    onChar() { stextCount++; },
  });

  // --- device path ---
  const dev = [];
  const device = new mupdf.Device({
    fillText(text, ctm) {
      text.walk({
        showGlyph(font, trm, glyph, unicode) {
          dev.push({ gid: glyph, unicode, c: unicode > 0 ? String.fromCodePoint(unicode) : "\uFFFD", x: trm[4], y: trm[5] });
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

  totalStext += stextCount;
  totalDevice += dev.length;

  if (p === 3) {
    // Rebuild the line containing the target word from the device output.
    const rows = new Map();
    for (const g of dev) {
      const key = Math.round(g.y * 2) / 2;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(g);
    }
    for (const [y, gs] of rows) {
      const visual = gs.sort((a, b) => a.x - b.x).map((g) => g.c).join("");
      if (!visual.includes(rev(CORE)) && !visual.includes(CORE)) continue;
      const logical = [...visual].reverse().join("");
      console.log(`\nPAGE 4, the line with the dropped alef (device path):`);
      console.log(`  visual : ${JSON.stringify(visual)}`);
      console.log(`  reversed: ${JSON.stringify(logical)}`);
      const want = "\u0648" + ALEF + "\u0644" + ALEF + NOON + HAH + RAH + ALEF + FEH;  // walinhiraf
      console.log(`  contains full "والانحراف"? ${logical.includes(want)}`);
      console.log(`  contains broken "ولانحراف"? ${logical.includes("\u0648\u0644" + ALEF + NOON + HAH + RAH + ALEF + FEH)}`);
      break;
    }
  }
}

console.log(`\nWHOLE DOCUMENT, 21 pages`);
console.log(`  structured-text glyphs : ${totalStext}`);
console.log(`  device showGlyph glyphs: ${totalDevice}`);
console.log(`  difference             : ${totalDevice - totalStext}`);
