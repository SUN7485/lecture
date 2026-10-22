/**
 * Rank every page of a deck by how far OUR render sits from the source page.
 *
 * The existing `comparePage` assumes the source page and the slide share a
 * coordinate space. That is true of the 28-deck corpus and false of any
 * document whose pages are not all one size: Unit Five is 87 landscape pages
 * and 31 square ones, and the square ones are fitted into the landscape canvas
 * with empty side bands. Compared full-width, a perfect slide scores ~0.35 and
 * the ranking is dominated by the band.
 *
 * This walks the whole deck with the fit applied, so the number describes the
 * reconstruction. It exists to answer one question — WHICH pages are worst —
 * so that a human looks at the worst ones first instead of at page 1.
 *
 * Usage:
 *   node experiments/compare-deck.js <pdf> <renderDir> <pptx> [--top N] [--json out.json]
 *
 * `renderDir` is a directory of slide-NNN.png as written by src/render/powerpoint.js.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { comparePage } from "../src/render/compare.js";
import { inspectPptx } from "../src/pptx/inspect.js";

const [pdfPath, renderDir, pptxPath] = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const TOP = Number(argOf("--top", 15));
const JSON_OUT = argOf("--json", null);

if (!pdfPath || !renderDir || !pptxPath) {
  console.error("usage: node experiments/compare-deck.js <pdf> <renderDir> <pptx> [--top N] [--json out.json]");
  process.exit(2);
}

// The canvas comes from the ARTIFACT, not from a re-derivation of which page
// size won the vote — the deck itself is the authority on what it was built at.
const report = await inspectPptx(pptxPath);
const canvas = report.slideSizePt;

const doc = mupdf.Document.openDocument(fs.readFileSync(pdfPath), "application/pdf");
const pageCount = doc.countPages();

const rows = [];
for (let i = 0; i < pageCount; i++) {
  const png = path.join(renderDir, `slide-${String(i + 1).padStart(3, "0")}.png`);
  if (!fs.existsSync(png)) continue;

  const b = doc.loadPage(i).getBounds();
  const srcW = b[2] - b[0], srcH = b[3] - b[1];
  const scale = Math.min(canvas.w / srcW, canvas.h / srcH);
  const xPt = (canvas.w - srcW * scale) / 2;
  const yPt = (canvas.h - srcH * scale) / 2;
  const fitted = Math.abs(scale - 1) > 0.0001 || Math.abs(xPt) > 0.05 || Math.abs(yPt) > 0.05;

  const r = comparePage(pdfPath, i, png, {
    fit: fitted ? { xPt, yPt, canvasWPt: canvas.w } : null,
  });

  rows.push({
    page: i + 1,
    fitted,
    sizePt: `${srcW.toFixed(0)}x${srcH.toFixed(0)}`,
    iou: r.best.iou,
    missingPct: r.best.missingPct,
    extraPct: r.best.extraPct,
    inkRatio: r.inkRatio,
    dy: r.best.dy,
  });
  if ((i + 1) % 10 === 0) process.stderr.write(`  ...${i + 1}/${pageCount}\n`);
}

rows.sort((a, b) => a.iou - b.iou);

const pct = (v) => (v * 100).toFixed(1).padStart(5);
console.log(`\n${path.basename(pdfPath)} — ${rows.length} pages, canvas ${canvas.w.toFixed(2)}x${canvas.h.toFixed(2)}pt\n`);
console.log("  page  size      fit   inkIoU  missing  extra   inkRatio  dy");
console.log("  ----  --------  ----  ------  -------  ------  --------  --");
for (const r of rows.slice(0, TOP)) {
  console.log(
    `  ${String(r.page).padStart(4)}  ${r.sizePt.padEnd(8)}  ${r.fitted ? " fit" : "  — "}` +
    `  ${r.iou.toFixed(3)}  ${pct(r.missingPct)}%  ${pct(r.extraPct)}%  ${r.inkRatio.toFixed(3).padStart(8)}  ${String(r.dy).padStart(3)}`
  );
}

const mean = rows.reduce((n, r) => n + r.iou, 0) / rows.length;
const band = (lo, hi) => rows.filter((r) => r.iou >= lo && r.iou < hi).length;
console.log(`\n  mean inkIoU ${mean.toFixed(3)}`);
console.log(`  <0.50 ${band(0, 0.5)}   0.50-0.70 ${band(0.5, 0.7)}   0.70-0.85 ${band(0.7, 0.85)}   >=0.85 ${band(0.85, 1.01)}`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
  console.log(`\n  wrote ${JSON_OUT}`);
}
