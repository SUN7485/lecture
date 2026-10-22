/**
 * Dump the RAW MuPDF walk (no grouping, no sorting, no filtering) inside an
 * x/y window, under several option sets, to prove whether a glyph exists at all.
 *
 *   node experiments/raw-window.js <page> <yTarget> <xMin> <xMax>
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";

const PDF = process.env.PDF ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const PAGE = Number(process.argv[2] ?? 3);
const Y = Number(process.argv[3] ?? 177);
const XMIN = Number(process.argv[4] ?? 285);
const XMAX = Number(process.argv[5] ?? 302);

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");

for (const opt of [
  "preserve-whitespace,preserve-spans,inhibit-spaces",
  "preserve-whitespace,preserve-spans",
  "preserve-spans,preserve-ligatures",
  "preserve-whitespace,preserve-spans,inhibit-spaces,use-cid-for-unknown-unicode",
  "preserve-whitespace,preserve-spans,inhibit-spaces,accurate-bboxes",
]) {
  const hits = [];
  let seq = 0;
  doc.loadPage(PAGE).toStructuredText(opt).walk({
    onChar(c, origin, font, size, quad) {
      const s = seq++;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const yOk = Y < 0 || Math.abs(origin[1] - Y) < 2;
      if (yOk && origin[0] >= XMIN && origin[0] <= XMAX) {
        hits.push({ c, x: origin[0], y: origin[1], x0, x1, seq: s, font: font.getName().replace(/^[A-Z]{6}\+/, "") });
      }
    },
  });
  console.log(`\n=== ${opt} === (${hits.length} glyphs in window)`);
  for (const h of hits.sort((a, b) => a.x - b.x)) {
    console.log(
      `  ${JSON.stringify(h.c).padEnd(5)} U+${h.c.codePointAt(0).toString(16).padStart(4, "0")} ` +
        `x=${h.x.toFixed(2)} [${h.x0.toFixed(2)},${h.x1.toFixed(2)}] w=${(h.x1 - h.x0).toFixed(2)} seq=${h.seq} ${h.font}`
    );
  }
}
