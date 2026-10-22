/**
 * Dump the identity of every block and whether it matches truth verbatim.
 *
 * The pass/fail gate for any extraction change is "verbatim blocks must rise AND
 * nothing else may regress". Category counts cannot prove the second half:
 * categorize-misses reports only the FIRST divergence, so repairing an early
 * error makes a block fail later instead and looks like a new defect in a
 * different bucket. Comparing the actual SETS is the only honest test.
 *
 * Blocks are keyed by page geometry (baseline and right edge) rather than by
 * index or text, so a block keeps its identity even when its text changes.
 *
 * Usage:
 *   node experiments/verbatim-set.js > before.txt   # on the old code
 *   node experiments/verbatim-set.js > after.txt    # on the new code
 *   node experiments/verbatim-set.js --diff before.txt after.txt
 *
 *   node experiments/verbatim-set.js --text > before.txt   # then `cmp` the two
 *
 * `--text` dumps the TEXT of every block instead of its verdict, so two runs can
 * be compared for BYTE IDENTITY rather than for "no verdict changed". The verdict
 * dump cannot prove a no-op: two blocks can both be wrong and still differ, so a
 * refactor that rewrites text without moving any block across the pass/fail line
 * reads as `0 fixed / 0 broken` — a green gate over a changed corpus. Any change
 * that is supposed to be pure plumbing is gated on this, not on --diff.
 *
 * It covers every block on every page, INCLUDING pages with no slide behind them,
 * which the verdict dump skips. Nothing here needs ground truth, so nothing is
 * excluded from the comparison.
 */
import * as fs from "node:fs";
import * as mupdf from "mupdf";
import { extractGlyphs, buildLines, blockText, blockIsRtl } from "../src/extract/glyphs.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { ligatureArity } from "../src/extract/cff-names.js";

const PAIRS = findPairs();

if (process.argv[2] === "--diff") {
  const parse = (f) => new Map(
    fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("\t");
      return [l.slice(i + 1), l.slice(0, i) === "1"];
    })
  );
  const before = parse(process.argv[3]);
  const after = parse(process.argv[4]);

  const fixed = [], broken = [], appeared = [], vanished = [];
  for (const [k, wasOk] of before) {
    if (!after.has(k)) { vanished.push(k); continue; }
    const isOk = after.get(k);
    if (!wasOk && isOk) fixed.push(k);
    if (wasOk && !isOk) broken.push(k);
  }
  for (const k of after.keys()) if (!before.has(k)) appeared.push(k);

  // A block that DISAPPEARS is not automatically harmless, and reporting it in
  // one undifferentiated "vanished" number hid that. A change which merges
  // blocks (the orphan-fragment pass) deletes keys wholesale, and a deleted key
  // that was VERBATIM is a correct block that no longer exists — indistinguish-
  // able, in the old output, from deleting a block that was already wrong.
  const vanishedOk = vanished.filter((k) => before.get(k)).length;

  console.log(`blocks before ${before.size}   after ${after.size}`);
  console.log(`  FIXED    (miss -> verbatim): ${fixed.length}`);
  console.log(`  BROKEN   (verbatim -> miss): ${broken.length}`);
  console.log(`  appeared (new block key):    ${appeared.length}`);
  console.log(`  vanished (block key gone):   ${vanished.length}`
    + `  (of which were verbatim: ${vanishedOk})`);
  if (broken.length) {
    console.log("\nREGRESSIONS — these were verbatim and are not any more:");
    for (const k of broken.slice(0, 25)) console.log(`  ${k}`);
    if (broken.length > 25) console.log(`  ...and ${broken.length - 25} more`);
  }
  // Net counts a vanished-verbatim block as the loss it is. For a merge pass the
  // honest reading is "the fragment stopped existing as its own block AND its
  // host became correct", so both sides have to appear in the arithmetic.
  const net = fixed.length - broken.length - vanishedOk;
  console.log(`\nnet ${net >= 0 ? "+" : ""}${net} blocks`
    + (vanishedOk ? `  (${fixed.length} fixed - ${broken.length} broken - ${vanishedOk} verbatim blocks removed)` : ""));
  console.log(broken.length === 0 ? "GATE PASS: no surviving block regressed." : "GATE FAIL: see regressions above.");
  process.exit(broken.length === 0 ? 0 : 1);
}

if (process.argv[2] === "--text") {
  for (const pair of PAIRS) {
    const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
    const arity = ligatureArity(doc.asPDF());
    for (let p = 0; p < doc.countPages(); p++) {
      for (const b of buildLines(extractGlyphs(doc.loadPage(p), arity))) {
        const got = blockText(b, blockIsRtl(b));
        if (!got) continue;
        console.log(`${pair.name} p${p + 1} y=${b.y.toFixed(1)} x1=${b.x1.toFixed(1)}\t${got}`);
      }
    }
  }
  process.exit(0);
}

for (const pair of PAIRS) {
  const name = pair.name;
  const doc = mupdf.Document.openDocument(fs.readFileSync(pair.pdf), "application/pdf");
  // The font's own ligature names, so this harness sees exactly what
  // modelFromPdf sees. Without it the gate is vacuous for any change that
  // reaches extraction through the arity map.
  const arity = ligatureArity(doc.asPDF());
  const slides = loadSlides(pair.html);

  // Page N is not always slide N (two decks carry a table-of-contents page with
  // no slide behind it). Scoring against the wrong slide would mark a whole deck
  // as a miss and hide every fix inside it — see alignPagesToSlides.
  const pageTexts = [];
  for (let p = 0; p < doc.countPages(); p++) {
    pageTexts.push(normalize(buildLines(extractGlyphs(doc.loadPage(p), arity)).map((b) => blockText(b, blockIsRtl(b))).join(" ")));
  }
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  for (let p = 0; p < doc.countPages(); p++) {
    if (align[p] < 0) continue;              // no truth behind this page
    const truthAll = slideText[align[p]];
    for (const b of buildLines(extractGlyphs(doc.loadPage(p), arity))) {
      const got = normalize(blockText(b, blockIsRtl(b)));
      if (!got) continue;
      // Geometry, not text: the key must survive the very change being measured.
      const key = `${name} p${p + 1} y=${b.y.toFixed(1)} x1=${b.x1.toFixed(1)}`;
      console.log(`${truthAll.includes(got) ? 1 : 0}\t${key}`);
    }
  }
}
