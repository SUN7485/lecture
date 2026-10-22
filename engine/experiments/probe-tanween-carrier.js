/**
 * WHICH letter lost its fathatan — alef, or something else?
 *
 * The repair assumes the carrier is an alef, because that is the ordinary
 * spelling of the indefinite accusative. On `Chp1-Lec3-2(New)` slide 12 the
 * source says `جودةً` and the repair writes `جوداً`: right shape, wrong letter,
 * and now it reads as a real word instead of a visibly broken one.
 *
 * The page knows. This measures how often an unmatched device glyph near the
 * site NAMES the missing carrier, and whether trusting it beats assuming alef.
 *
 * Usage: node experiments/probe-tanween-carrier.js
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl, sourceEvidence } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { STRANDED_FATHATAN, repairStrandedFathatan } from "../web/doctor.js";

const SAME_POSITION = 1.0;
/** Letters that can legitimately carry a fathatan at the end of a word. */
const CARRIER = /[اةءآأإى]/u;

let flagged = 0, withNamedCarrier = 0, carrierIsAlef = 0, carrierIsOther = 0;
const byCarrier = new Map();
let alefFixed = 0, namedFixed = 0, namedDiffers = 0;
const differs = [];

for (const pair of findPairs()) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p)))
      .map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;
    const truth = slideText[align[p]];
    const glyphs = extractGlyphs(doc.loadPage(p));
    const lines = buildLines(glyphs);
    const ev = sourceEvidence(lines, glyphs.deviceGlyphs, (b) => blockText(b, blockIsRtl(b)));

    for (const b of lines) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got || !STRANDED_FATHATAN.test(got)) continue;
      flagged++;
      const lamAlefLost = ev.get(b)?.lamAlefLost ?? false;

      // Device glyphs on this line with no structured-text glyph at their place.
      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      const unmatched = glyphs.deviceGlyphs.filter((d) =>
        Math.abs(d.y - b.y) <= 1.5 && d.x >= x0 - 1 && d.x <= x1 + 1 &&
        d.unicode !== 0xfffd &&
        !b.glyphs.some((g) => Math.abs(g.x0 - d.x) <= SAME_POSITION || Math.abs(g.x - d.x) <= SAME_POSITION));

      // Of those, the ones that decompose to a legitimate fathatan carrier.
      const carriers = unmatched
        .map((d) => String.fromCodePoint(d.unicode).normalize("NFKC"))
        .filter((s) => s.length === 1 && CARRIER.test(s));

      const asAlef = normalize(repairStrandedFathatan(got, lamAlefLost));
      if (truth.includes(asAlef)) alefFixed++;

      if (carriers.length === 1) {
        withNamedCarrier++;
        const c = carriers[0];
        byCarrier.set(c, (byCarrier.get(c) ?? 0) + 1);
        if (c === "ا") carrierIsAlef++; else carrierIsOther++;

        // Same repair, but insert what the DEVICE named instead of an alef.
        const named = normalize(repairStrandedFathatan(got, lamAlefLost).replace(/ا(?=ً)/u, c));
        if (truth.includes(named)) namedFixed++;
        if (named !== asAlef) {
          namedDiffers++;
          if (differs.length < 12) {
            differs.push(`${pair.name} p${p + 1}  device says "${c}"`
              + `\n      alef  : ${asAlef.slice(0, 70)}\n      named : ${named.slice(0, 70)}`
              + `\n      truth?: alef=${truth.includes(asAlef)} named=${truth.includes(named)}`);
          }
        }
      }
    }
  }
}

console.log(`stranded-fathatan blocks              : ${flagged}`);
console.log(`  exactly one named unmatched carrier : ${withNamedCarrier}`);
console.log(`    the device says alef              : ${carrierIsAlef}`);
console.log(`    the device says something else    : ${carrierIsOther}`);
console.log(`\ncarriers the device named: ${[...byCarrier].map(([c, n]) => `${c}x${n}`).join("  ")}`);
console.log(`\nrepair scored over ALL ${flagged} flagged blocks:`);
console.log(`  always insert alef        : ${alefFixed} verbatim`);
console.log(`  insert what device named  : ${namedFixed} verbatim  (of the ${withNamedCarrier} it can speak for)`);
console.log(`  cases where they DIFFER   : ${namedDiffers}`);
for (const d of differs) console.log(`  ${d}`);
