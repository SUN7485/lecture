import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines } from "../src/extract/glyphs.js";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const BLOCK = Number(process.argv[2] ?? 0);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const glyphs = extractGlyphs(doc.loadPage(0));
const blocks = buildLines(glyphs);
const b = blocks[BLOCK];

console.log(`block ${BLOCK}: ${b.glyphs.length} glyphs, ${b.family} @ ${b.size}pt`);
console.log("idx  char  U+     origin.x   x0     x1    adv?  lig  seq");
for (const [i, g] of b.glyphs.entries()) {
  const next = b.glyphs[i + 1];
  const gap = next ? (next.x0 - g.x1).toFixed(2) : "-";
  console.log(
    `${String(i).padStart(3)}  ${JSON.stringify(g.c).padEnd(6)} ` +
      `${g.c.codePointAt(0).toString(16).padStart(4, "0")}  ` +
      `${g.x.toFixed(2).padStart(7)} ${g.x0.toFixed(2).padStart(6)} ${g.x1.toFixed(2).padStart(6)} ` +
      `${String(gap).padStart(6)}  ${String(g.ligatureGroup ?? "").padStart(3)}  ${g.paintSeq}`
  );
}
