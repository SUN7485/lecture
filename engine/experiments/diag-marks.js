import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, isCombiningMark } from "../src/extract/glyphs.js";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const glyphs = extractGlyphs(doc.loadPage(0));

const hex = (c) => c.codePointAt(0).toString(16).padStart(4, "0");

// Work on raw paint order so we can see what precedes/follows a mark natively.
for (const [i, g] of glyphs.entries()) {
  if (!isCombiningMark(g.c)) continue;
  const prev = glyphs[i - 1], next = glyphs[i + 1];
  const containing = glyphs.filter(
    (o) => o !== g && !isCombiningMark(o.c) && Math.abs(o.y - g.y) < 3 && o.x0 - 0.2 <= g.x && g.x <= o.x1 + 0.2
  );
  console.log(
    `mark U+${hex(g.c)} seq=${g.paintSeq} x=${g.x.toFixed(2)} w=${(g.x1 - g.x0).toFixed(2)}\n` +
      `   paint-prev: ${prev ? `${JSON.stringify(prev.c)} U+${hex(prev.c)} x=${prev.x.toFixed(2)} [${prev.x0.toFixed(2)},${prev.x1.toFixed(2)}]` : "-"}\n` +
      `   paint-next: ${next ? `${JSON.stringify(next.c)} U+${hex(next.c)} x=${next.x.toFixed(2)} [${next.x0.toFixed(2)},${next.x1.toFixed(2)}]` : "-"}\n` +
      `   contains-x: ${containing.map((o) => `${JSON.stringify(o.c)}@${o.x.toFixed(2)}`).join(" ") || "(none)"}`
  );
}
