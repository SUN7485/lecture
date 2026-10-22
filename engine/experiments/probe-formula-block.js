/**
 * What is really going on in the formula lines?
 *
 * These are the largest remaining miss class (82 of 374). Measured examples:
 *
 *   got  : "قراءة × 480 = 5,760 12"          truth: "12 × 480 = 5,760"
 *   got  : "بايت × 25 = 2,880,000 115,200"    truth: "115,200 × 25 = 2,880,000"
 *
 * Every number is present and correct but the leading operand ends up last, and
 * an Arabic unit word is attached that the truth line does not contain. Before
 * designing anything, dump the actual glyph geometry: are the label and the
 * formula one visual run or two, and where does the ordering actually go wrong?
 *
 * Read-only.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, withSpaces } from "../src/extract/glyphs.js";
import { visualToLogical } from "../src/extract/bidi.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const DIR = "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\";
const NAME = process.argv[2] ?? "Chp1-Lec1-3(New)";
const PAGE = Number(process.argv[3] ?? 18) - 1;   // reports are 1-indexed

const doc = mupdf.Document.openDocument(fs.readFileSync(DIR + NAME + ".pdf"), "application/pdf");
const slides = loadSlides(DIR + NAME + "-edited.html");

console.log(`=== ${NAME} p${PAGE + 1} ===\n`);
console.log("TRUTH LINES:");
for (const line of slides[PAGE].split("\n").map(normalize).filter(Boolean)) console.log(`   ${JSON.stringify(line)}`);

const blocks = buildLines(extractGlyphs(doc.loadPage(PAGE)));
console.log(`\n${blocks.length} BLOCKS (in reading order):`);
for (const [i, b] of blocks.entries()) {
  const rtl = blockIsRtl(b);
  console.log(`  [${i}] y=${b.y.toFixed(1)} x0=${b.x0.toFixed(1)} x1=${b.x1.toFixed(1)} rtl=${rtl} ${JSON.stringify(blockText(b, rtl))}`);
}

// Focus on a block that mixes Arabic with an arithmetic expression.
const target = blocks.find((b) => {
  const t = blockText(b, blockIsRtl(b));
  return /[\u0600-\u06FF]/.test(t) && /[=×÷+]/.test(t) && /\d/.test(t);
});
if (!target) { console.log("\nno mixed formula block found on this page"); process.exit(0); }

const rtl = blockIsRtl(target);
console.log(`\n=== FOCUS BLOCK  rtl=${rtl} ===`);
console.log(`text: ${JSON.stringify(blockText(target, rtl))}`);

const ordered = visualToLogical(withSpaces(target.glyphs), rtl);
console.log("\nVISUAL order (as painted, ascending x):");
const visual = withSpaces(target.glyphs);
console.log("    idx  char  x        x0       x1       script");
const scriptOf = (c) => /[\u0600-\u06FF]/.test(c) ? "Arab" : /[0-9]/.test(c) ? "digit" : /[A-Za-z]/.test(c) ? "Latn" : "neutral";
for (const [i, g] of visual.entries()) {
  console.log(`    ${String(i).padStart(3)}  ${JSON.stringify(g.c).padEnd(6)} ${(g.x ?? 0).toFixed(2).padStart(8)} ${(g.x0 ?? 0).toFixed(2).padStart(8)} ${(g.x1 ?? 0).toFixed(2).padStart(8)}  ${scriptOf(g.c)}`);
}

console.log("\nLOGICAL order produced:");
console.log("    " + JSON.stringify(ordered.map((g) => g.c).join("")));

// What would the same glyphs give if the block were treated as LTR?
console.log("\nSame glyphs forced LTR:");
console.log("    " + JSON.stringify(visualToLogical(withSpaces(target.glyphs), false).map((g) => g.c).join("")));
