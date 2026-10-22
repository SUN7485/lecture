/**
 * JSONL of every block whose base direction is the ONLY thing wrong with it
 * (`prize`), plus every block the current direction gets right and the other one
 * would break (`protected`), plus the ones that are wrong either way (`other`).
 * The visual glyph stream and the word counts blockIsRtl decides on are
 * included, because that is the evidence a rule has to be built from — the
 * reconstructed text is already a consequence of the decision being questioned.
 *
 * Blocks that are right either way are omitted: no direction rule can change
 * their verdict, so they are not part of any trade.
 *
 *   node experiments/dump-direction-prize.js > direction.jsonl
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, isCombiningMark } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

/** The word counts blockIsRtl decides on, exposed so rules can be tried offline. */
function wordCounts(block) {
  let arabicWords = 0, latinWords = 0, kind = null;
  for (const g of block.glyphs) {
    if (isCombiningMark(g.c)) continue;
    if (/\s/.test(g.c)) { kind = null; continue; }
    const isArabic = /[؀-ۿݐ-ݿ]/.test(g.c);
    const isLatin = /[A-Za-z0-9]/.test(g.c);
    if (!isArabic && !isLatin) continue;
    const k = isArabic ? "a" : "l";
    if (k !== kind) { if (k === "a") arabicWords++; else latinWords++; kind = k; }
  }
  return { arabicWords, latinWords };
}

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);

  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p))).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truthAll = slideText[align[p]];

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const rtl = blockIsRtl(b);
      const got = normalize(blockText(b, rtl));
      if (!got) continue;
      const flipped = normalize(blockText(b, !rtl));
      const okNow = truthAll.includes(got);
      const okFlipped = truthAll.includes(flipped);
      const cell = okNow && okFlipped ? "insensitive" : okNow ? "protected" : okFlipped ? "prize" : "other";
      if (cell === "insensitive") continue;

      console.log(JSON.stringify({
        cell,
        deck: pair.name,
        page: p + 1,
        y: Number(b.y.toFixed(1)),
        x0: Number(b.x0.toFixed(1)),
        x1: Number(b.x1.toFixed(1)),
        rtl,
        ...wordCounts(b),
        visual: normalize(b.glyphs.map((g) => g.c).join("")),
        got,
        flipped,
      }));
    }
  }
}
