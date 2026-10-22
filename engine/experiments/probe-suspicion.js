/**
 * Can the pipeline tell WHICH blocks it got wrong, without ground truth?
 *
 * The doctor's 18 rules can only find defects it can NAME. The largest miss
 * class in this corpus — 239 of 612, "letters lost inside a ligature glyph the
 * font does not name" — has no nameable signature in the output text at all:
 * `يفصّل` comes out `يفل` and both are ordinary-looking Arabic.
 *
 * But the extractor is not blind to it. When the font does not name a glyph, the
 * device path reports U+FFFD, and that is a fact about the SOURCE, available on
 * any PDF, with no HTML beside it. This measures whether that fact predicts a
 * wrong block — precision and recall against the real verbatim set over all 28
 * decks — so a doctor rule can be written from a number instead of a hunch.
 *
 * Usage: node experiments/probe-suspicion.js
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { deviceGlyphs, owedOf } from "../src/extract/ligatures.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { ligatureArity } from "../src/extract/cff-names.js";

/** A device glyph belongs to a block if it sits on its baseline, within its span. */
const BASELINE_TOLERANCE = 1.5;
const X_MARGIN = 1.0;

const stats = {
  blocks: 0, verbatim: 0,
  // signal -> { flagged, flaggedWrong }
  signals: new Map(),
};
const note = (name, flagged, wrong) => {
  if (!stats.signals.has(name)) stats.signals.set(name, { flagged: 0, flaggedWrong: 0 });
  if (!flagged) return;
  const s = stats.signals.get(name);
  s.flagged++;
  if (wrong) s.flaggedWrong++;
};

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
    const truthAll = slideText[align[p]];
    const page = doc.loadPage(p);
    const devs = deviceGlyphs(page, arity);
    const blocks = buildLines(extractGlyphs(doc.loadPage(p), arity));

    for (const b of blocks) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      stats.blocks++;
      const wrong = !truthAll.includes(got);
      if (!wrong) stats.verbatim++;

      const x0 = Math.min(...b.glyphs.map((g) => g.x0));
      const x1 = Math.max(...b.glyphs.map((g) => g.x1));
      const mine = devs.filter((d) =>
        Math.abs(d.y - b.y) <= BASELINE_TOLERANCE && d.x >= x0 - X_MARGIN && d.x <= x1 + X_MARGIN);
      if (!mine.length) { note("no device glyphs found for the block", true, wrong); continue; }

      // The device reports a glyph the font does not name as U+FFFD, and
      // `unicode` here is a CODE POINT, not a string — comparing it against "�"
      // silently matches nothing and reports a dead signal as a clean one.
      const unnamed = mine.filter((d) => d.unicode === 0xfffd).length;
      const owed = mine.reduce((n, d) => n + (d.owed ?? owedOf(d.unicode)), 0);
      const supplied = b.glyphs.length;
      const deficit = owed - supplied;

      note("any unnamed device glyph", unnamed > 0, wrong);
      note("device owes MORE than stext supplied", deficit > 0, wrong);
      note("device owes FEWER than stext supplied", deficit < 0, wrong);
      note("  surplus >= 2", deficit <= -2, wrong);
      note("  surplus >= 3", deficit <= -3, wrong);
      note("  surplus >= 5", deficit <= -5, wrong);
      note("unnamed present OR owes more", unnamed > 0 || deficit > 0, wrong);

      // Language-shaped signals, independent of the device evidence, so they can
      // reach misses the counting rule cannot see.
      //
      // Fathatan (U+064B) marks an indefinite accusative and in ordinary
      // orthography it sits on a final alef — `مساراً`. Finding it on a bare
      // consonant (`مسارً`) is the fingerprint of a dropped alef, which is
      // exactly the loss this project has chased at three different sites.
      // ة and ء legitimately carry it and are excluded.
      // BOTH sides count: `مختلفاً` writes the mark after its alef and `قممًا`
      // writes it before, and both are ordinary spellings of the same word. Only
      // a fathatan with no alef on either side has lost one.
      const strandedTanween = /[^اةءآأإ]ً(?![اةءآأإ])/u.test(got);
      note("fathatan not sitting on an alef", /[^اةءآأإ]ً/u.test(got), wrong);
      note("fathatan with no alef on EITHER side", strandedTanween, wrong);

      // A combining mark with nothing before it has lost its base outright.
      note("line starts with a combining mark", /^[ً-ْٰ]/u.test(got), wrong);
      // Two marks in a row on one base is almost always a mis-binding.
      note("two combining marks in a row", /[ً-ْٰ]{2}/u.test(got), wrong);
      // A space between a letter and the mark that belongs on it.
      note("space before a combining mark", /\s[ً-ْٰ]/u.test(got), wrong);

      note("stranded fathatan OR owes more", strandedTanween || deficit > 0, wrong);
    }
  }
}

const misses = stats.blocks - stats.verbatim;
const base = misses / stats.blocks;
console.log(`blocks ${stats.blocks} · verbatim ${stats.verbatim} `
  + `(${((stats.verbatim / stats.blocks) * 100).toFixed(2)}%) · misses ${misses}`);
console.log(`a block picked at random is wrong ${(base * 100).toFixed(1)}% of the time — `
  + `a signal is only worth a rule if it beats that\n`);

console.log("signal                                    flagged   wrong   precision   recall   lift");
for (const [name, s] of stats.signals) {
  const precision = s.flagged ? s.flaggedWrong / s.flagged : 0;
  const recall = misses ? s.flaggedWrong / misses : 0;
  console.log(`${name.padEnd(41)} ${String(s.flagged).padStart(6)} `
    + `${String(s.flaggedWrong).padStart(7)} ${(precision * 100).toFixed(1).padStart(10)}% `
    + `${(recall * 100).toFixed(1).padStart(7)}% ${(precision / base).toFixed(2).padStart(6)}x`);
}
