/**
 * Minimal isolation: dump every glyph on the baseline containing a target
 * substring, in raw paint order AND in sorted visual order, so we can see
 * exactly where a stray space comes from.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, isCombiningMark } from "../src/extract/glyphs.js";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE = Number(process.argv[2] ?? 1);
const NEEDLE = process.argv[3] ?? "يتح";

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const glyphs = extractGlyphs(doc.loadPage(PAGE));
const blocks = buildLines(glyphs);

const hex = (c) => c.codePointAt(0).toString(16).padStart(4, "0");
const target = blocks.find((b) => blockText(b).includes(NEEDLE));
if (!target) { console.log(`"${NEEDLE}" not found on page ${PAGE}`); process.exit(0); }

console.log(`block text: ${blockText(target)}\n`);

// Find the glyph window around the needle by locating its letters in x order.
const gs = target.glyphs;
console.log("VISUAL ORDER (as sorted), showing 26 glyphs around the densest mark cluster:");
const markIdx = gs.findIndex((g) => isCombiningMark(g.c));
const from = Math.max(0, markIdx - 8), to = Math.min(gs.length, markIdx + 18);

console.log("idx  char U+     x        x0      x1     w      mark grp seq");
for (let i = from; i < to; i++) {
  const g = gs[i];
  console.log(
    `${String(i).padStart(3)}  ${JSON.stringify(g.c).padEnd(5)} ${hex(g.c)}  ` +
      `${g.x.toFixed(2).padStart(7)} ${g.x0.toFixed(2).padStart(7)} ${g.x1.toFixed(2).padStart(7)} ` +
      `${(g.x1 - g.x0).toFixed(2).padStart(5)}  ${g.isMark ? "M" : " "}   ${String(g.groupId ?? "").padStart(3)} ${g.paintSeq}`
  );
}
