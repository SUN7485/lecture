/**
 * Does the arity map's KEY ever match the name the device reports?
 *
 * `ligatureArity` keys on the FontDescriptor's `/FontName`. `deviceGlyphs` looks
 * up `font.getName()`, which is the name MuPDF reads out of the font program.
 * Those are not always the same string, and when they differ every ligature that
 * font knows about is invisible — the glyph owes 1, the line balances, and every
 * count-based gate stays shut on a word that lost a letter.
 *
 * Counts, per deck: how many painted glyphs belong to a font the map HAS under
 * some name, how many actually resolved, and how many would resolve if the
 * subset tag were used instead of the full name.
 *
 *   node experiments/probe-arity-key.js
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { ligatureArity } from "../src/extract/cff-names.js";
import { findPairs } from "../src/truth/corpus.js";

const tagOf = (name) => (String(name).match(/^([A-Z]{6})\+/) ?? [])[1] ?? null;

let totalGlyphs = 0, resolvedNow = 0, resolvedByTag = 0;
const mismatches = new Map();

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const arity = ligatureArity(doc.asPDF());
  if (!arity.size) continue;
  const byTag = new Map();
  for (const [name, ligs] of arity) { const t = tagOf(name); if (t) byTag.set(t, ligs); }

  for (let p = 0; p < doc.countPages(); p++) {
    const page = doc.loadPage(p);
    const device = new mupdf.Device({
      fillText(text) {
        text.walk({
          showGlyph(font, trm, glyph) {
            const name = font.getName();
            totalGlyphs++;
            if (arity.get(name)?.get(glyph)) resolvedNow++;
            const t = tagOf(name);
            if (t && byTag.get(t)?.get(glyph)) resolvedByTag++;
            if (t && byTag.has(t) && !arity.has(name)) {
              const key = `${name}  ->  map has ${[...arity.keys()].filter((k) => tagOf(k) === t).join(", ")}`;
              mismatches.set(key, (mismatches.get(key) ?? 0) + 1);
            }
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
  }
}

console.log(`painted glyphs                       : ${totalGlyphs}`);
console.log(`  a ligature resolved by NAME (today): ${resolvedNow}`);
console.log(`  a ligature resolved by SUBSET TAG  : ${resolvedByTag}`);
console.log(`\nnames the device reports that the map does not hold:`);
for (const [k, n] of [...mismatches].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(7)}  ${k}`);
}
