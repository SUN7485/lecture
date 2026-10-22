/**
 * The 107 blocks that provably lost characters — WHICH characters, and can we
 * put them back?
 *
 * KNOWN_ISSUES records a repair of this shape that was built, measured and
 * reverted: `repairSkippedGlyphs` fixed 4 blocks and broke 1711, because it was
 * validated as a per-BASELINE detector and run as a per-baseline repair, where
 * the character it could not see is exactly the character it duplicated. That
 * entry sets the conditions for a second attempt:
 *
 *   "the repair has to run per BLOCK, after buildLines, which means threading
 *    the device glyphs through to it — and it should be measured against the
 *    same probe before and after"
 *
 * Both are now available: `extractGlyphs` hands back its device walk, and
 * `sourceEvidence` says which blocks are short and by how many, at 100%
 * precision. This asks the prior question before any repair is written: for
 * those blocks, is the missing character NAMED by the device, or is it the
 * unnamed-glyph case that no amount of position matching can rescue?
 *
 * Usage: node experiments/probe-missing-chars.js [--show]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, sourceEvidence } from "../src/extract/glyphs.js";
import { owedOf } from "../src/extract/ligatures.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { ligatureArity } from "../src/extract/cff-names.js";

const SHOW = process.argv.includes("--show");
/** A device glyph and a stext glyph at the same place are the same glyph. */
const SAME_X = 1.0;

let blocks = 0, unmatchedTotal = 0, named = 0, unnamed = 0;
const byChar = new Map();
const samples = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  // The font's own ligature names, exactly as modelFromPdf supplies them.
  const arity = ligatureArity(doc.asPDF());
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p), arity))
      .map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const glyphs = extractGlyphs(doc.loadPage(p), arity);
    const lines = buildLines(glyphs);
    const evidence = sourceEvidence(lines, glyphs.deviceGlyphs, (b) => blockText(b, blockIsRtl(b)));

    for (const b of lines) {
      const ev = evidence.get(b);
      if (!ev || ev.missing <= 0) continue;
      blocks++;

      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      const mine = glyphs.deviceGlyphs.filter((d) =>
        Math.abs(d.y - b.y) <= 1.5 && d.x >= x0 - 1 && d.x <= x1 + 1);

      // Which device glyphs have no stext glyph standing at the same place?
      const unmatched = mine.filter((d) =>
        !b.glyphs.some((g) => Math.abs(g.x0 - d.x) <= SAME_X || Math.abs(g.x - d.x) <= SAME_X));

      unmatchedTotal += unmatched.length;
      for (const d of unmatched) {
        const isUnnamed = d.unicode === 0xfffd;
        if (isUnnamed) unnamed++; else named++;
        const key = isUnnamed ? "U+FFFD (font names nothing)"
          : `${String.fromCodePoint(d.unicode)} U+${d.unicode.toString(16).toUpperCase()}${owedOf(d.unicode) > 1 ? " (ligature, owes 2)" : ""}`;
        byChar.set(key, (byChar.get(key) ?? 0) + 1);
      }

      if (SHOW && samples.length < 18) {
        samples.push(`${pair.name} p${p + 1}  short by ${ev.missing}, unmatched ${unmatched.length}`
          + `  [${unmatched.map((d) => d.unicode === 0xfffd ? "?" : String.fromCodePoint(d.unicode)).join(" ")}]`
          + `\n      ${normalize(blockText(b, blockIsRtl(b))).slice(0, 78)}`);
      }
    }
  }
}

console.log(`blocks short of characters : ${blocks}`);
console.log(`device glyphs with no stext glyph at their position : ${unmatchedTotal}`);
console.log(`  NAMED by the font   : ${named}   <- these could be put back`);
console.log(`  unnamed (U+FFFD)    : ${unnamed}   <- position matching cannot rescue these\n`);
console.log("what the unmatched glyphs are:");
for (const [k, n] of [...byChar].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${String(n).padStart(5)}  ${k}`);
}
if (SHOW) {
  console.log("\nsamples:");
  for (const s of samples) console.log(`  ${s}`);
}
