/**
 * What the PACKAGE declares, per slide: slide size and the bounding box of every
 * shape offset. Answers "is the shrink already in the XML, or does it happen at
 * render time" without opening PowerPoint.
 */
import * as fs from "node:fs";
import JSZip from "jszip";
const EMU = 12700;
const zip = await JSZip.loadAsync(fs.readFileSync(process.argv[2]));
const pres = await zip.file("ppt/presentation.xml").async("string");
const sz = pres.match(/<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
console.log(`\nslide size  ${(+sz[1] / EMU).toFixed(2)} x ${(+sz[2] / EMU).toFixed(2)} pt`);
const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
  .sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
const rows = [];
for (const n of names) {
  const xml = await zip.file(n).async("string");
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, count = 0;
  for (const m of xml.matchAll(/<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
    const x = +m[1] / EMU, y = +m[2] / EMU, w = +m[3] / EMU, h = +m[4] / EMU;
    if (w <= 0 || h <= 0) continue;
    count++; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  rows.push({ slide: +n.match(/\d+/)[0], count, x0, y0, x1, y1 });
}
rows.sort((a, b) => a.slide - b.slide);
const want = new Set(process.argv.slice(3).map(Number));
console.log(`\nslide  objs        content bbox (pt)                 w x h        left band  right band`);
for (const r of rows) {
  if (want.size && !want.has(r.slide)) continue;
  if (!r.count) { console.log(`  ${String(r.slide).padStart(3)}   0   (empty)`); continue; }
  const W = +sz[1] / EMU;
  console.log(`  ${String(r.slide).padStart(3)}  ${String(r.count).padStart(4)}   ${r.x0.toFixed(1).padStart(7)},${r.y0.toFixed(1).padStart(7)} .. ${r.x1.toFixed(1).padStart(7)},${r.y1.toFixed(1).padStart(7)}   ${(r.x1 - r.x0).toFixed(1).padStart(6)}x${(r.y1 - r.y0).toFixed(1).padStart(6)}   ${r.x0.toFixed(1).padStart(6)}    ${(W - r.x1).toFixed(1).padStart(6)}`);
}
// Whole-deck view: the left band per slide is the fingerprint of a fitted page.
if (!want.size) {
  console.log(`\nleft-band runs (a non-zero band means the page was fitted):`);
  let start = 1, prev = Math.round(rows[0].x0);
  for (let i = 1; i <= rows.length; i++) {
    const cur = i < rows.length ? Math.round(rows[i].x0) : null;
    if (cur !== prev) { console.log(`  slides ${String(start).padStart(3)}-${String(i).padStart(3)}   left band ~${prev}pt`); start = i + 1; prev = cur; }
  }
}
console.log("");
