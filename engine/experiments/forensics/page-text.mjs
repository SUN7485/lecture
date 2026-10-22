/**
 * Every reconstructed block of one page of ANY pdf, with the three orders that
 * can disagree side by side:
 *
 *   RAW      what mupdf's structured text hands over, unmodified
 *   VISUAL   the page's own glyph sequence sorted by x (what a reader sees L->R)
 *   OURS     blockText() — the logical order we ship
 *
 * A bidi complaint is only actionable once these three are on screen together;
 * "the equation is reordered" describes a difference between two of them and
 * never says which.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, blockRuns } from "../../src/extract/glyphs.js";

const PDF = process.argv[2];
const PAGE = Number(process.argv[3]);
const NEEDLE = process.argv[4] ?? null;

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const page = doc.loadPage(PAGE - 1);

// RAW structured text, exactly as the library reports it.
const raw = [];
page.toStructuredText("preserve-whitespace,preserve-spans").walk({
  beginTextBlock() {}, endTextBlock() {},
  beginLine() { raw.push([]); }, endLine() {},
  onChar(c) { raw[raw.length - 1]?.push(c); },
});

const blocks = buildLines(extractGlyphs(page));
console.log(`\n${PDF.split(/[\/]/).pop()}  page ${PAGE} — ${blocks.length} blocks, ${raw.length} raw lines\n`);

for (const [i, b] of blocks.entries()) {
  const rtl0 = blockIsRtl(b);
  const ours = blockText(b, rtl0);
  if (NEEDLE && !ours.includes(NEEDLE)) continue;
  const rtl = rtl0;
  const visual = [...b.glyphs].sort((g, h) => g.x - h.x).map((g) => g.c).join("");
  const paint = b.glyphs.map((g) => g.c).join("");
  console.log(`#${i}  y=${b.y?.toFixed(1)}  x ${b.x0?.toFixed(1)}..${b.x1?.toFixed(1)}  rtl=${rtl}  glyphs=${b.glyphs.length}`);
  console.log(`  PAINT  ${JSON.stringify(paint)}`);
  console.log(`  VISUAL ${JSON.stringify(visual)}`);
  console.log(`  OURS   ${JSON.stringify(ours)}`);
  const runs = blockRuns(b, rtl);
  console.log(`  RUNS   ${runs.map((r) => `[${r.script ?? "?"}${r.rtl ? ":rtl" : ""}]${JSON.stringify(r.text)}`).join(" ")}`);
  console.log("");
}
