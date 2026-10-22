/**
 * When a line is split into several boxes, do those boxes still sit apart?
 *
 * WHY THIS EXISTS. A reader reported that on one slide a phrase was drawn 14pt
 * on top of the words before it. The block's TEXT was character-perfect and the
 * model held it as ONE object, so `delivered-set.js` was blind to it and so was
 * every render-side check that compares model objects: the two things colliding
 * were not two objects, they were two SEGMENTS the writer makes out of one.
 *
 * `segmentByFieldBoxes` exists because the source draws inline "chips" — a
 * rounded box around `=STDEV.P()` in the middle of an Arabic sentence — and a
 * chip is a shape pinned to absolute coordinates while the text around it is a
 * line PowerPoint re-lays out. The honest reading is that such a line is not one
 * positioned unit but several, so each group of runs is emitted at the
 * coordinates its own glyphs occupied.
 *
 * That is only true while the boxes it splits on really are chips. On
 * `Chp1-Lec3-2(New)` slide 9 the TABLE HEADER CELLS below the line overlapped it
 * by 2.09pt — 9.8% of its height, enough to pass a 2pt test — three of four runs
 * were re-anchored to header cells and CENTRED in them, and the segment
 * rectangles then overlapped each other by 21.7pt.
 *
 * THE INVARIANT IS EXACT AND NEEDS NO RENDER: segments of one line are pieces of
 * one line, so their rectangles must not overlap. A render-side version of this
 * check was written first and thrown away — it compared each line's ink extent
 * against the source's and could not tell a defect from ordinary reflow (p90
 * 8.7pt of legitimate drift against a 2.3pt defect), and comparing model objects
 * cannot see this failure at all because both halves belong to the same object.
 *
 *   node experiments/verify-segments.js <pdf> [more.pdf ...]
 *   node experiments/verify-segments.js --corpus
 *
 * Exit 1 if any line's own segments overlap.
 */
import * as path from "node:path";
import { modelFromPdf } from "../src/model/normalize.js";
import { segmentByFieldBoxes } from "../src/pptx/write.js";
import { findPairs } from "../src/truth/corpus.js";
import { requireSubjects } from "./lib-gate.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const PDFS = process.argv.includes("--corpus") ? findPairs().map((p) => p.pdf) : args;
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 10);
if (!PDFS.length) {
  console.error("usage: node experiments/verify-segments.js <pdf> [more.pdf ...] | --corpus");
  process.exit(2);
}

/** Two segment rectangles this far into each other are drawn over each other. */
const OVERLAP_PT = 0.5;

let totalSplit = 0, totalBad = 0, filesRead = 0;
const rows = [];

for (const pdf of PDFS) {
  const model = modelFromPdf(pdf);
  filesRead++;
  let split = 0, bad = 0;
  for (const [pi, page] of model.pages.entries()) {
    const shapes = page.objects.filter((o) => o.type === "shape");
    for (const o of page.objects) {
      if (o.type !== "text") continue;
      const segs = segmentByFieldBoxes(o, shapes);
      if (!segs || segs.length < 2) continue;
      split++;
      const sorted = [...segs].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) {
        const ov = (sorted[i - 1].x + sorted[i - 1].w) - sorted[i].x;
        if (ov <= OVERLAP_PT) continue;
        bad++;
        rows.push({
          deck: path.basename(pdf, ".pdf"), page: pi + 1, ov,
          a: sorted[i - 1], b: sorted[i], text: o.text,
        });
      }
    }
  }
  totalSplit += split;
  totalBad += bad;
  console.log(`${path.basename(pdf, ".pdf").padEnd(24)} ${String(split).padStart(4)} lines split  ${bad ? `${String(bad).padStart(3)} OVERLAPPING` : "  0  ok"}`);
}

if (rows.length) {
  console.log("");
  for (const r of rows.slice(0, SHOW)) {
    console.log(`  ${r.deck} p${r.page}  two segments of one line overlap by ${r.ov.toFixed(1)}pt`);
    console.log(`     ${r.a.x.toFixed(1)}..${(r.a.x + r.a.w).toFixed(1)} (${r.a.align})  vs  ${r.b.x.toFixed(1)}..${(r.b.x + r.b.w).toFixed(1)} (${r.b.align})`);
    console.log(`     ${r.text.slice(0, 88)}`);
  }
  if (rows.length > SHOW) console.log(`  … and ${rows.length - SHOW} more`);
}

// `--corpus` yields nothing at all if the corpus root has moved, and 0 split
// lines out of 0 files would otherwise read as a clean pass.
requireSubjects(filesRead, "PDFs", "check the paths, or the corpus root behind --corpus.");
console.log("=".repeat(72));
console.log(`  ${totalSplit} lines split at a chip · ${totalBad} with overlapping segments`);
console.log(totalBad
  ? "\n  GATE FAIL: a line is being drawn on top of itself."
  : "\n  GATE PASS: every split line's pieces stay apart.");
process.exit(totalBad ? 1 : 0);
