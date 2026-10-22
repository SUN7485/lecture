/**
 * Dump a whole reconstructed block in sorted visual order, with every
 * discriminator the sort uses, so a specific word can be traced end to end.
 *
 *   node experiments/isolate-block.js <page> "<substring of block text>" [from] [count]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText } from "../src/extract/glyphs.js";

const PDF = process.env.PDF ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE = Number(process.argv[2] ?? 3);
const NEEDLE = process.argv[3] ?? "لانحراف";
const FROM = Number(process.argv[4] ?? 0);
const COUNT = Number(process.argv[5] ?? 24);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const blocks = buildLines(extractGlyphs(doc.loadPage(PAGE)));
const b = blocks.find((x) => blockText(x).includes(NEEDLE));
if (!b) { console.log(`no block containing "${NEEDLE}" on page ${PAGE}`); process.exit(0); }

console.log(`text: ${blockText(b)}`);
console.log(`glyphs: ${b.glyphs.length}\n`);
console.log("idx  char U+     origin   sortX     x0      x1      w    mark grp seq");
for (const [i, g] of b.glyphs.slice(FROM, FROM + COUNT).entries()) {
  console.log(
    `${String(i + FROM).padStart(3)}  ${JSON.stringify(g.c).padEnd(5)} ` +
      `${g.c.codePointAt(0).toString(16).padStart(4, "0")} ` +
      `${g.x.toFixed(2).padStart(8)} ${(g.sortX ?? g.x).toFixed(2).padStart(8)} ` +
      `${g.x0.toFixed(2).padStart(7)} ${g.x1.toFixed(2).padStart(7)} ` +
      `${(g.x1 - g.x0).toFixed(2).padStart(5)}   ${g.isMark ? "M" : " "}  ${String(g.groupId ?? "").padStart(3)} ${g.paintSeq}`
  );
}
