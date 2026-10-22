// PNG or JPEG? Measured, per image, over every deck that has images.
//
// The stake is not only file size. These decks carry screenshots of Arabic text,
// and JPEG rings glyph edges — so paying bytes for a lossless PNG is the RIGHT
// trade wherever PNG is not dramatically larger. This prints both sizes and both
// costs so the rule can be chosen from the corpus instead of from instinct.
import * as mupdf from "mupdf";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const pdfs = [];
function walk(dir, depth) {
  if (depth > 3) return;
  let entries; try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (extname(e).toLowerCase() === ".pdf") pdfs.push(p);
  }
}
for (const r of process.argv.slice(2)) walk(r, 0);

const rows = [];
for (const f of pdfs) {
  let doc; try { doc = mupdf.Document.openDocument(readFileSync(f), "application/pdf"); } catch { continue; }
  for (let i = 0; i < doc.countPages(); i++) {
    const page = doc.loadPage(i);
    const dev = new mupdf.Device({
      fillImage(image) {
        try {
          const pm = image.toPixmap();
          const px = pm.getWidth() * pm.getHeight();
          const t0 = Date.now(); const png = pm.asPNG().length; const tPng = Date.now() - t0;
          const t1 = Date.now(); const jpg = pm.asJPEG(90, false).length; const tJpg = Date.now() - t1;
          rows.push({ px, comps: pm.getNumberOfComponents(), png, jpg, tPng, tJpg });
        } catch { /* the unreadable ones are a separate question */ }
      },
      fillPath() {}, strokePath() {}, clipPath() {}, clipStrokePath() {}, fillText() {},
      strokeText() {}, clipText() {}, clipStrokeText() {}, ignoreText() {}, fillShade() {},
      fillImageMask() {}, clipImageMask() {}, popClip() {}, beginMask() {}, endMask() {},
      beginGroup() {}, endGroup() {}, beginTile() { return 0; }, endTile() {}, close() {}, drop() {},
    });
    try { page.run(dev, mupdf.Matrix.identity); dev.close(); } catch { /* next page */ }
  }
}

const kb = (n) => (n / 1024).toFixed(0).padStart(6);
console.log("  pixels  comps    PNG kb    JPG kb   ratio  smaller   png ms  jpg ms");
for (const r of rows.sort((a, b) => b.px - a.px)) {
  console.log(`${String(r.px).padStart(9)} ${String(r.comps).padStart(5)} ${kb(r.png)} ${kb(r.jpg)} `
    + `${(r.png / r.jpg).toFixed(2).padStart(7)}  ${(r.png < r.jpg ? "PNG" : "JPEG").padStart(5)} `
    + `${String(r.tPng).padStart(8)}${String(r.tJpg).padStart(8)}`);
}
const pngWins = rows.filter((r) => r.png < r.jpg).length;
const totPng = rows.reduce((n, r) => n + r.png, 0), totJpg = rows.reduce((n, r) => n + r.jpg, 0);
console.log(`\n${rows.length} images · PNG smaller on ${pngWins} · all-PNG ${(totPng / 1048576).toFixed(1)}MB `
  + `vs all-JPEG ${(totJpg / 1048576).toFixed(1)}MB`);
console.log(`encode cost total: PNG ${rows.reduce((n, r) => n + r.tPng, 0)}ms · JPEG ${rows.reduce((n, r) => n + r.tJpg, 0)}ms`);
