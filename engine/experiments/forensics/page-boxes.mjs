/**
 * Physical page geometry, per page, straight from the PDF — no model, no fitting.
 *
 * Answers the only question that can distinguish "the source really has two page
 * sizes" from "we are reading the wrong box": MediaBox, CropBox, Trim, Bleed, Art,
 * /Rotate and /UserUnit side by side with what `page.getBounds()` (what the
 * extractor actually uses) returns.
 */
import * as mupdf from "mupdf";
const file = process.argv[2];
const doc = mupdf.Document.openDocument(file);
const n = doc.countPages();
const rows = [];
for (let i = 0; i < n; i++) {
  const p = doc.loadPage(i);
  const get = (box) => { try { const [a,b,c,d] = p.getBounds(box); return [ +(c-a).toFixed(2), +(d-b).toFixed(2), +a.toFixed(2), +b.toFixed(2) ]; } catch { return null; } };
  const obj = p.getObject?.();
  const raw = (k) => { try { const v = obj.get(k); return v && !v.isNull() ? v.toString() : null; } catch { return null; } };
  const inherited = (k) => { try { const v = obj.getInheritable ? obj.getInheritable(k) : null; return v && !v.isNull() ? v.toString() : null; } catch { return null; } };
  rows.push({
    page: i + 1,
    bounds: get(),          // what the extractor uses
    media: get("MediaBox"), crop: get("CropBox"),
    trim: get("TrimBox"), bleed: get("BleedBox"), art: get("ArtBox"),
    rotate: raw("Rotate") ?? inherited("Rotate"),
    userUnit: raw("UserUnit"),
    rawMedia: raw("MediaBox"), rawCrop: raw("CropBox"),
    transform: (() => { try { return p.getTransform().map((v) => +v.toFixed(4)); } catch { return null; } })(),
  });
  p.destroy?.();
}
// Group by the bounds the extractor sees, then print every transition.
const key = (r) => r.bounds ? `${r.bounds[0]}x${r.bounds[1]}` : "?";
const groups = new Map();
for (const r of rows) groups.set(key(r), (groups.get(key(r)) ?? 0) + 1);
console.log(`\n${n} pages — page sizes the EXTRACTOR sees (page.getBounds()):`);
for (const [k, c] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${k}`);

console.log(`\nruns:`);
let start = 1;
for (let i = 1; i <= n; i++) {
  if (i === n || key(rows[i]) !== key(rows[i - 1])) { console.log(`  pages ${String(start).padStart(3)}-${String(i).padStart(3)}   ${key(rows[i - 1])}`); start = i + 1; }
}
const want = new Set(process.argv.slice(3).map(Number));
if (want.size) {
  console.log(`\nper-page detail:`);
  for (const r of rows.filter((x) => want.has(x.page))) {
    console.log(`  p${r.page}`);
    console.log(`     bounds   ${JSON.stringify(r.bounds)}`);
    console.log(`     Media    ${JSON.stringify(r.media)}   raw ${r.rawMedia}`);
    console.log(`     Crop     ${JSON.stringify(r.crop)}   raw ${r.rawCrop}`);
    console.log(`     Trim     ${JSON.stringify(r.trim)}    Bleed ${JSON.stringify(r.bleed)}    Art ${JSON.stringify(r.art)}`);
    console.log(`     Rotate   ${r.rotate}   UserUnit ${r.userUnit}   transform ${JSON.stringify(r.transform)}`);
  }
}
console.log("");
