import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs } from "../src/extract/glyphs.js";

const PDF = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");

for (const p of [0, 1, 5]) {
  const glyphs = extractGlyphs(doc.loadPage(p));
  const spaces = glyphs.filter((g) => g.c === " ");
  const solid = glyphs.filter((g) => g.c.trim());
  // group spaces by the baseline they sit on, to see which lines have them
  const byLine = new Map();
  for (const g of spaces) {
    const k = Math.round(g.y);
    byLine.set(k, (byLine.get(k) ?? 0) + 1);
  }
  console.log(
    `page ${p}: ${glyphs.length} glyphs | ${solid.length} solid | ${spaces.length} REAL space glyphs on ${byLine.size} baselines`
  );
  const widths = spaces.map((g) => +(g.x1 - g.x0).toFixed(2));
  console.log(`   space widths: ${[...new Set(widths)].sort((a, b) => a - b).join(", ")}`);
}
