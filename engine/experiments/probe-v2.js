import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText } from "../src/extract/glyphs.js";

const PDF = process.argv[2] ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGES = (process.argv[3] ?? "0").split(",").map(Number);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");

for (const p of PAGES) {
  const page = doc.loadPage(p);
  const glyphs = extractGlyphs(page);
  const blocks = buildLines(glyphs);
  const ligs = new Set(glyphs.filter((g) => g.groupId != null).map((g) => g.groupId)).size;

  console.log("=".repeat(74));
  console.log(`PAGE ${p}: ${glyphs.length} glyphs -> ${blocks.length} blocks | ${ligs} ligature groups`);
  console.log("=".repeat(74));
  for (const [i, b] of blocks.entries()) {
    console.log(
      `[${String(i).padStart(2)}] y=${b.y.toFixed(0).padStart(3)} x=${b.x0.toFixed(0).padStart(3)}-${b.x1.toFixed(0).padStart(3)} ${b.size.toFixed(1)}pt ${b.family}`
    );
    console.log(`     ${blockText(b)}`);
  }
}
