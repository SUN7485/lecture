/**
 * What actually happens at a tanween/alef site?
 *
 * KNOWN_ISSUES: truth "اً" comes out as a stranded "ً" with the alef gone, or
 * with both moved. It survived the lam-alef repair, so it is NOT that fault and
 * must be measured on its own before anything is changed.
 *
 * This dumps the raw glyph stream around each failing site so the defect is read
 * off the data rather than guessed: character, paint sequence, x-extent, whether
 * MuPDF called it a mark, and what the block came out as versus the source.
 *
 *   node experiments/probe-tanween.js [deckName] [maxSites]
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs } from "../src/truth/corpus.js";

const ONLY = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : null;
const MAX = Number(process.argv.find((a, i) => i > 1 && /^\d+$/.test(a)) ?? 6);

const TANWEEN = "ً";           // fathatan
const ALEF = "ا";
const hex = (c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");

const pairs = findPairs().filter((p) => !ONLY || p.name === ONLY);
let shown = 0;

// Corpus-wide shape counts, so the sample below is known to be representative.
const shapes = new Map();
const bump = (k) => shapes.set(k, (shapes.get(k) ?? 0) + 1);

outer:
for (const pair of pairs) {
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  const slides = loadSlides(pair.html);

  for (let p = 0; p < Math.min(doc.countPages(), slides.length); p++) {
    const truthAll = normalize(slides[p].replace(/\n/g, " "));
    if (!truthAll.includes(ALEF + TANWEEN)) continue;

    for (const b of buildLines(extractGlyphs(doc.loadPage(p)))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got || truthAll.includes(got)) continue;
      if (!got.includes(TANWEEN)) continue;

      // Which shape is this? Counted over the whole corpus, not just the sample.
      const gotAT = (got.match(new RegExp(ALEF + TANWEEN, "g")) ?? []).length;
      const gotT = (got.match(new RegExp(TANWEEN, "g")) ?? []).length;
      if (gotAT === gotT) bump("tanween always follows an alef (looks intact)");
      else if (got.includes(TANWEEN + ALEF)) bump("tanween BEFORE the alef");
      else bump("tanween with no adjacent alef");

      if (shown >= MAX) continue;
      // Only dump sites where the tanween is genuinely detached.
      if (gotAT === gotT) continue;
      shown++;

      console.log("=".repeat(76));
      console.log(`${pair.name} p${p + 1}`);
      console.log(`  got   ${got.slice(0, 100)}`);
      const i = truthAll.indexOf(got.slice(0, 14));
      console.log(`  truth ${(i >= 0 ? truthAll.slice(i, i + 100) : "(not located)")}`);
      console.log("  glyph stream in PAINT order — c, seq, x0..x1, mark?");

      // Window the dump around the detached tanween so the output stays readable.
      const idx = b.glyphs.findIndex((g) => g.c === TANWEEN);
      const from = Math.max(0, idx - 8), to = Math.min(b.glyphs.length, idx + 9);
      for (let k = from; k < to; k++) {
        const g = b.glyphs[k];
        const w = (g.x1 - g.x0).toFixed(2);
        console.log(
          `    ${k === idx ? ">>" : "  "} ${JSON.stringify(g.c)} ${hex(g.c).padEnd(7)}` +
          ` seq ${String(g.paintSeq ?? "?").padStart(4)}  x ${g.x0.toFixed(2)}..${g.x1.toFixed(2)} (w ${w})` +
          `  ${g.isMark ? "MARK" : ""}`
        );
      }
      if (shown >= MAX && shapes.size) { /* keep counting, stop printing */ }
    }
  }
  if (false) break outer;
}

console.log("=".repeat(76));
console.log("SHAPE OF THE DEFECT, corpus-wide (blocks containing a tanween that miss):");
for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
