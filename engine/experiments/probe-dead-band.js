/**
 * What does the ink dead band change, page by page?
 *
 * `compare.js` used a hard cut at INK_THRESHOLD, so two renderers disagreeing by
 * ONE greyscale value on a large flat fill moved that whole fill in or out of
 * the mask. This scores every page BOTH ways through the same `comparePage` —
 * `deadBand: 0` is the old behaviour — so the change is measured rather than
 * asserted, and the pages it moves can be looked at.
 *
 * Usage:
 *   node experiments/probe-dead-band.js <pdf> <renderDir> [--pages 1,34,36]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { comparePage } from "../src/render/compare.js";

const args = process.argv.slice(2);
const [PDF, DIR] = args.filter((a) => !a.startsWith("--"));
const only = args.includes("--pages")
  ? new Set(args[args.indexOf("--pages") + 1].split(",").map(Number))
  : null;

if (!PDF || !DIR) {
  console.error("usage: node experiments/probe-dead-band.js <pdf> <renderDir> [--pages 1,34]");
  process.exit(1);
}

const slides = fs.readdirSync(DIR).filter((f) => /^slide-\d+\.png$/.test(f)).sort();
console.log("page   hard cut   dead band    delta   undecided px   note");
console.log("-".repeat(74));

let moved = 0, sumOld = 0, sumNew = 0, n = 0, rescued = 0;
for (const file of slides) {
  const page = Number(file.match(/\d+/)[0]);
  if (only && !only.has(page)) continue;
  const png = path.join(DIR, file);
  const before = comparePage(PDF, page - 1, png, { deadBand: 0 });
  const after = comparePage(PDF, page - 1, png);
  const d = after.best.iou - before.best.iou;
  n++; sumOld += before.best.iou; sumNew += after.best.iou;
  if (Math.abs(d) >= 0.01) moved++;
  // The failure this exists to stop: a correct page scored as a catastrophe.
  const rescue = before.best.iou < 0.5 && after.best.iou >= 0.5;
  if (rescue) rescued++;
  if (Math.abs(d) >= 0.01 || rescue) {
    console.log(
      String(page).padStart(4),
      before.best.iou.toFixed(3).padStart(10), after.best.iou.toFixed(3).padStart(11),
      (d >= 0 ? "+" : "") + d.toFixed(3).padStart(7),
      String(after.undecidedPx).padStart(14),
      rescue ? "   RESCUED from <0.50" : ""
    );
  }
}

console.log("-".repeat(74));
console.log(`${n} pages · mean ${(sumOld / n).toFixed(4)} -> ${(sumNew / n).toFixed(4)} ` +
            `· ${moved} moved by >=0.01 · ${rescued} rescued from below 0.50`);
