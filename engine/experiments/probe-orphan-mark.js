/**
 * Where does a spurious combining mark come from?
 *
 * `EXTRA char "ً"` is the largest single-character miss class left (118 blocks).
 * The reconstructed line carries a fathatan the source does not have, sitting at
 * the LINE START, e.g. "تًتمحور" for "تتمحور". Before inventing a rule for it,
 * look at the raw glyph: its y, its size, what MuPDF called it, and which base
 * the extractor gave it.
 *
 *   node experiments/probe-orphan-mark.js <deck> <page1based> [xMin]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { findPairs } from "../src/truth/corpus.js";

const [deck, pageArg, xMinArg] = process.argv.slice(2);
const pair = findPairs().find((p) => p.name === deck);
if (!pair) { console.error(`no deck named ${deck}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
const page = doc.loadPage(Number(pageArg) - 1);
const glyphs = extractGlyphs(page);
const xMin = Number(xMinArg ?? 655);

console.log(`glyphs with x0 >= ${xMin} — the right margin band, where a line STARTS:`);
for (const g of glyphs.filter((x) => x.x0 >= xMin).sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
  console.log(`  y ${g.y.toFixed(2)}  x ${g.x0.toFixed(2)}..${g.x1.toFixed(2)}  ${JSON.stringify(g.c)}` +
    ` U+${g.c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}  seq ${g.paintSeq}` +
    `  size ${g.size?.toFixed(1)}  ${g.isMark ? "MARK" : ""}`);
}

const marks = glyphs.filter((g) => g.isMark);
console.log(`\nevery mark on the page (${marks.length}), with the base the extractor chose:`);
for (const m of marks) {
  console.log(`  y ${m.y.toFixed(2)}  x ${m.x0.toFixed(2)}  ${JSON.stringify(m.c)}  seq ${m.paintSeq}` +
    `  base ${JSON.stringify(m.base?.c ?? null)} at y ${m.base?.y?.toFixed(2) ?? "-"} x ${m.base?.x0?.toFixed(2) ?? "-"}`);
}

console.log("\nblocks on this page:");
for (const b of buildLines(glyphs)) {
  const t = blockText(b, blockIsRtl(b));
  if (t) console.log(`  y ${b.y.toFixed(1)} x1 ${b.x1.toFixed(1)}  ${t.slice(0, 80)}`);
}
