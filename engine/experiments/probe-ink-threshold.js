/**
 * Is a page's "missing ink" real, or a flat fill sitting on the threshold?
 *
 * `compare.js` builds its ink mask with a hard binary cut (INK_THRESHOLD = 28:
 * ink is anything more than 28 below white). Two renderers disagreeing by ONE
 * greyscale value on a large flat fill therefore move that whole fill in or out
 * of the mask. Measured on the InDesign brand guide p34: the same grey renders
 * 226 in MuPDF and 227 in PowerPoint, which moves 38759 pixels — 64% of the
 * page's entire ink mask — and scored a correct page at 0.360 inkIoU with
 * "62.1% missing". Run this before believing any low inkIoU.
 *
 * Usage: node experiments/probe-ink-threshold.js <pdf> <pageIndex0> <slide.png>
 */
import * as fs from "node:fs";
import { PNG } from "pngjs";
import { renderPdfPage } from "../src/render/compare.js";

const [pdf, pageIdx, ourPng] = [process.argv[2], Number(process.argv[3]), process.argv[4]];
const ours = PNG.sync.read(fs.readFileSync(ourPng));
const src = renderPdfPage(pdf, pageIdx, ours.width);

const bucket = (get, n, label) => {
  // Count pixels by how far below white they are, in the band the threshold cuts.
  const bins = new Map();
  let ink = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = get(i);
    const d = Math.max(255 - r, 255 - g, 255 - b);
    total++;
    if (d > 28) ink++;
    if (d > 0 && d <= 60) bins.set(Math.floor(d / 5) * 5, (bins.get(Math.floor(d / 5) * 5) ?? 0) + 1);
  }
  console.log(`\n${label}:  ink ${ink} / ${total}  (${((ink / total) * 100).toFixed(1)}%)`);
  console.log("  distance-below-white histogram, 0<d<=60 (threshold cuts at 28):");
  for (const k of [...bins.keys()].sort((a, b) => a - b))
    console.log(`    ${String(k).padStart(2)}-${String(k + 4).padStart(2)}  ${String(bins.get(k)).padStart(8)}${k < 28 && k + 4 >= 28 ? "   <-- THRESHOLD" : ""}`);
};

bucket((i) => [src.data[i * src.channels], src.data[i * src.channels + 1], src.data[i * src.channels + 2]],
  src.width * src.height, `SOURCE  ${src.width}x${src.height}`);
bucket((i) => [ours.data[i * 4], ours.data[i * 4 + 1], ours.data[i * 4 + 2]],
  ours.width * ours.height, `OURS    ${ours.width}x${ours.height}`);
