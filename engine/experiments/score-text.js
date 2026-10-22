/**
 * Measure native-PDF text reconstruction against the source HTML, across the
 * whole document, in the same categories the earlier experiment reported as
 * failing (mixed script, digits, parentheses).
 *
 * Primary metric: does a reconstructed block appear VERBATIM in its slide's
 * ground-truth text? That is strict — it fails on any ordering, spacing,
 * digit or bracket error.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";

const PDF = process.argv[2] ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2.pdf";
const HTML = process.argv[3] ?? "C:\\Users\\mosun\\Downloads\\final lecs\\chp1\\done\\Chp1-Lec6-2-edited.html";

const AR = /[\u0600-\u06FF]/;
const LAT = /[A-Za-z]/;
const DIG = /[0-9]/;
const PAREN = /[()]/;

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const slides = loadSlides(HTML);
const pageCount = doc.countPages();

console.log(`PDF pages: ${pageCount}   HTML slides: ${slides.length}`);
if (slides.length !== pageCount) console.log("!! page/slide count mismatch — alignment is positional");

const cats = {
  all: { hit: 0, n: 0 },
  arabicOnly: { hit: 0, n: 0 },
  arabicLatin: { hit: 0, n: 0 },
  arabicDigits: { hit: 0, n: 0 },
  parens: { hit: 0, n: 0 },
};
const misses = [];

for (let p = 0; p < Math.min(pageCount, slides.length); p++) {
  const blocks = buildLines(extractGlyphs(doc.loadPage(p)));
  const truth = normalize(slides[p].replace(/\n/g, " "));

  for (const b of blocks) {
    const text = normalize(blockText(b, blockIsRtl(b)));
    if (!text || !AR.test(text + " ") && !LAT.test(text) && !DIG.test(text)) continue;

    const hit = truth.includes(text);
    const bump = (k) => { cats[k].n++; if (hit) cats[k].hit++; };

    bump("all");
    if (AR.test(text) && LAT.test(text)) bump("arabicLatin");
    else if (AR.test(text) && DIG.test(text)) bump("arabicDigits");
    else if (AR.test(text)) bump("arabicOnly");
    if (PAREN.test(text)) bump("parens");

    if (!hit) misses.push({ p, text });
  }
}

const pct = (c) => (c.n ? ((c.hit / c.n) * 100).toFixed(2) : "n/a").padStart(6);
console.log("\nVERBATIM BLOCK RECOVERY (block found exactly in source HTML)");
console.log("-".repeat(58));
for (const [k, c] of Object.entries(cats)) {
  console.log(`  ${k.padEnd(14)} ${pct(c)}%   (${c.hit}/${c.n})`);
}

console.log(`\nMISSES: ${misses.length}`);
for (const m of misses.slice(0, 25)) console.log(`  p${String(m.p + 1).padStart(2)}  ${m.text.slice(0, 96)}`);
