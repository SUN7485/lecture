/**
 * Can a glyph the device reports as U+FFFD be named after all?
 *
 * Half this corpus is subset-encoded with no usable ToUnicode entry for the
 * shaped forms, so `showGlyph` hands back U+FFFD and every repair that counts
 * "characters owed" is blind on those lines — measured: a line visibly missing a
 * letter reports a SURPLUS of 6.
 *
 * MuPDF's Font can encode the other way: character -> glyph id. Inverting that
 * over the Arabic ranges gives glyph -> character without any ToUnicode table.
 * This measures how much of the corpus that recovers.
 *
 *   node experiments/probe-glyph-naming.js [deck] [page1based]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { findPairs } from "../src/truth/corpus.js";

const [deckArg, pageArg] = process.argv.slice(2);
const pairs = findPairs().filter((p) => !deckArg || p.name === deckArg);

/** Every character worth asking a font about, in one list. */
const CANDIDATES = [];
for (const [lo, hi] of [[0x0600, 0x06ff], [0xfb50, 0xfdff], [0xfe70, 0xfeff], [0x0020, 0x007e]]) {
  for (let cp = lo; cp <= hi; cp++) CANDIDATES.push(cp);
}

const cache = new WeakMap();
function glyphNames(font) {
  let map = cache.get(font);
  if (map) return map;
  map = new Map();
  for (const cp of CANDIDATES) {
    let gid;
    try { gid = font.encodeCharacter(cp); } catch { continue; }
    if (!gid) continue;
    if (!map.has(gid)) map.set(gid, cp);         // first one wins; ties are rare
  }
  cache.set(font, map);
  return map;
}

let total = 0, unnamed = 0, recovered = 0;
const examples = [];

for (const pair of pairs) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const pages = pageArg ? [Number(pageArg) - 1] : [...Array(doc.countPages()).keys()];

  for (const p of pages) {
    const page = doc.loadPage(p);
    const device = new mupdf.Device({
      fillText(text) {
        text.walk({
          showGlyph(font, trm, glyph, unicode) {
            total++;
            if (unicode !== 0xfffd && unicode !== 0 && unicode !== -1) return;
            unnamed++;
            const cp = glyphNames(font).get(glyph);
            if (cp == null) return;
            recovered++;
            if (examples.length < 20) {
              examples.push(`${pair.name} p${p + 1}  glyph ${glyph} in ${font.getName()}` +
                `  ->  U+${cp.toString(16).toUpperCase().padStart(4, "0")} ${JSON.stringify(String.fromCodePoint(cp))}`);
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

console.log(`device glyphs ${total}`);
console.log(`  unnamed by ToUnicode: ${unnamed}  (${((unnamed / total) * 100).toFixed(1)}%)`);
console.log(`  named by inverting the font's own encoder: ${recovered}  (${unnamed ? ((recovered / unnamed) * 100).toFixed(1) : 0}% of those)`);
for (const e of examples) console.log(`    ${e}`);
