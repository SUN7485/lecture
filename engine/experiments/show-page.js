/**
 * Print every reconstructed block of one page beside the truth slide, with the
 * base direction the extractor chose. The fastest way to see WHY a line came out
 * the way it did, instead of guessing from a miss dump.
 *
 *   node experiments/show-page.js Chp4-Lec31-1 10
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { ligatureArity } from "../src/extract/cff-names.js";

const [deck, pageArg] = process.argv.slice(2);
const pair = findPairs().find((p) => p.name === deck);
if (!pair) { console.error(`no deck named ${deck}`); process.exit(2); }

const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
// Without the arity map this harness measures the OLD behaviour and reports a
// defect the pipeline no longer has. Any probe that bypasses modelFromPdf owes
// this line.
const arity = ligatureArity(doc.asPDF());
const slides = loadSlides(pair.html);
const pageTexts = [];
for (let p = 0; p < doc.countPages(); p++) {
  pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p), arity)).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
}
const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
const align = alignPagesToSlides(pageTexts, slideText);

const page = Number(pageArg) - 1;
const truthAll = align[page] >= 0 ? slideText[align[page]] : "";
console.log(`${deck} page ${pageArg} -> slide ${align[page] + 1}\n${"=".repeat(70)}`);

for (const b of buildLines(extractGlyphs(doc.loadPage(page), arity))) {
  const rtl = blockIsRtl(b);
  const got = normalize(blockText(b, rtl));
  if (!got) continue;
  const ok = truthAll.includes(got);
  console.log(`${ok ? "ok  " : "MISS"} ${rtl ? "rtl" : "ltr"} y=${b.y.toFixed(1)} x1=${b.x1.toFixed(1)}  ${got}`);
  if (!ok) console.log(`          flipped: ${normalize(blockText(b, !rtl))}`);
}
