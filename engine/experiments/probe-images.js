// Which PDFs actually contain raster images, and how many?
// Uses the project's own extractor so the answer matches what the pipeline sees.
// Usage: node experiments/probe-images.js <dir> [<dir>...]
import * as mupdf from "mupdf";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { extractVectors } from "../src/extract/vectors.js";

const roots = process.argv.slice(2);
const pdfs = [];
function walk(dir, depth) {
  if (depth > 3) return;
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, depth + 1);
    else if (extname(e).toLowerCase() === ".pdf") pdfs.push(p);
  }
}
for (const r of roots) walk(r, 0);

console.log(`scanning ${pdfs.length} pdfs\n`);
let withImages = 0;
for (const f of pdfs) {
  let doc;
  try { doc = mupdf.Document.openDocument(readFileSync(f), "application/pdf"); }
  catch (e) { console.log(`ERR  ${f}  ${e.message}`); continue; }
  let images = 0, pagesWithImages = 0;
  const pages = doc.countPages();
  const px = [];
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    try {
      const { images: ims } = extractVectors(page);
      if (ims.length) {
        pagesWithImages++; images += ims.length;
        for (const im of ims) px.push(`p${i}:${im.widthPx}x${im.heightPx}`);
      }
    } catch { /* keep going: one bad page must not hide the rest of the corpus */ }
  }
  if (images) {
    withImages++;
    console.log(`${String(images).padStart(4)} images on ${pagesWithImages}/${pages} pages   ${f}`);
    console.log(`       ${px.slice(0, 8).join(" ")}`);
  }
}
console.log(`\n${withImages} of ${pdfs.length} pdfs contain images`);
