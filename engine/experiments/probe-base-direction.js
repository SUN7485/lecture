/**
 * How much of the remaining miss set is a BASE DIRECTION mistake, and nothing
 * else?
 *
 * For every block, score it as extracted and score it again with the base
 * direction flipped. That splits the corpus into four cells:
 *
 *   insensitive  right either way (one island, or no directional structure)
 *   protected    right today, WRONG if flipped  -> what any new rule may not break
 *   PRIZE        wrong today, RIGHT if flipped  -> the ceiling of a direction fix
 *   other        wrong either way               -> a character bug, not direction
 *
 * The prize is the only honest ceiling for a direction rule: a block in `other`
 * cannot be reached by choosing the direction better, however convincing the
 * line looks. Samples of PRIZE and protected are printed so a discriminator can
 * be looked for in the evidence rather than guessed.
 *
 *   node experiments/probe-base-direction.js [samples]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

const SAMPLES = Number(process.argv[2] ?? 12);
const cells = { insensitive: 0, protected: 0, prize: 0, other: 0 };
const show = { prize: [], protected: [] };

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

      const where = `${pair.name} p${p + 1} y=${b.y.toFixed(1)}`;
      if (okNow && okFlipped) cells.insensitive++;
      else if (okNow) {
        cells.protected++;
        if (show.protected.length < SAMPLES) show.protected.push(`${where} [${rtl ? "rtl" : "ltr"}]\n      kept    ${got.slice(0, 90)}\n      flipped ${flipped.slice(0, 90)}`);
      } else if (okFlipped) {
        cells.prize++;
        if (show.prize.length < SAMPLES) show.prize.push(`${where} [${rtl ? "rtl" : "ltr"} -> ${rtl ? "ltr" : "rtl"}]\n      got     ${got.slice(0, 90)}\n      flipped ${flipped.slice(0, 90)}`);
      } else cells.other++;
    }
  }
}

const total = Object.values(cells).reduce((a, b) => a + b, 0);
console.log(`blocks ${total}`);
for (const [k, v] of Object.entries(cells)) console.log(`${String(v).padStart(6)}  ${((v / total) * 100).toFixed(2).padStart(6)}%  ${k}`);
console.log(`\nPRIZE — wrong now, right with the other base direction:`);
for (const s of show.prize) console.log(`  ${s}`);
console.log(`\nPROTECTED — right now, wrong if flipped:`);
for (const s of show.protected) console.log(`  ${s}`);
