/**
 * Phase 4 gate: convert -> render through PowerPoint -> compare against the
 * source PDF, and report the numbers that were previously guessed.
 *
 *   node experiments/calibrate.js [pdf] [pages]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { modelFromPdf } from "../src/model/normalize.js";
import { writePptx } from "../src/pptx/write.js";
import { renderPptx, powerPointAvailable } from "../src/render/powerpoint.js";
import { comparePage } from "../src/render/compare.js";

const PDF = process.argv[2] ?? "C:/Users/mosun/Downloads/final lecs/chp1/done/Chp1-Lec6-2.pdf";
const COUNT = Number(process.argv[3] ?? 4);
const WORK = path.resolve("out/calibrate");

fs.mkdirSync(WORK, { recursive: true });
if (!powerPointAvailable()) { console.error("PowerPoint not found"); process.exit(1); }

const pages = [...Array(COUNT).keys()];
const model = modelFromPdf(PDF, { pages });
const pptx = path.join(WORK, "calib.pptx");
await writePptx(model, pptx);

const render = renderPptx(pptx, path.join(WORK, "png"), { widthPx: 1400 });
if (!render.opened) { console.error("PowerPoint failed to open:", render.error); process.exit(1); }

console.log(`PowerPoint: opened=${render.opened} repaired=${render.repaired}`);
console.log(`slide size: ${render.pageWidthPt} x ${render.pageHeightPt} pt   (model ${model.pages[0].widthPt} x ${model.pages[0].heightPt})`);

// --- geometry: model bbox vs the shape PowerPoint actually created -----------
const deltas = [];
for (const [i, page] of model.pages.entries()) {
  const shapes = render.slides[i]?.shapes ?? [];
  page.objects.forEach((obj, j) => {
    const sh = shapes[j];
    if (!sh) return;
    // Text boxes are written with a half-leading nudge; shapes are not.
    const lead = obj.type === "text" && obj.runs?.length
      ? Math.max(...obj.runs.map((r) => r.fontSizePt)) * 0.18 / 2
      : 0;
    deltas.push(Math.hypot(sh.left - obj.bbox.x, sh.top - (obj.bbox.y - lead)));
  });
}
deltas.sort((a, b) => a - b);
const pct = (p) => (deltas.length ? deltas[Math.floor(deltas.length * p)] : NaN);

console.log(`\nSHAPE GEOMETRY (model -> PowerPoint shape, ${deltas.length} objects)`);
console.log(`  p50 ${pct(0.5).toFixed(3)} pt   p95 ${pct(0.95).toFixed(3)} pt   max ${deltas[deltas.length - 1]?.toFixed(3)} pt`);

// --- ink: source page vs PowerPoint's render --------------------------------
console.log(`\nINK COMPARISON (source PDF vs PowerPoint render)`);
console.log("page   inkRatio   IoU(raw)   IoU(best)   bestShift   missing   extra");
const shifts = [];
for (const i of pages) {
  const png = path.join(WORK, "png", `slide-${String(i + 1).padStart(3, "0")}.png`);
  if (!fs.existsSync(png)) continue;
  const c = comparePage(PDF, i, png, { widthPx: 1400 });
  shifts.push(c.best.dy);
  console.log(
    `${String(i + 1).padStart(4)}   ${c.inkRatio.toFixed(3).padStart(8)}   ` +
      `${c.raw.iou.toFixed(4).padStart(8)}   ${c.best.iou.toFixed(4).padStart(9)}   ` +
      `${String(c.best.dy).padStart(9)}px   ${(c.best.missingPct * 100).toFixed(1).padStart(6)}%  ${(c.best.extraPct * 100).toFixed(1).padStart(6)}%`
  );
}

const median = shifts.slice().sort((a, b) => a - b)[Math.floor(shifts.length / 2)];
const pxPerPt = 1400 / model.pages[0].widthPt;
console.log(`\nBASELINE CALIBRATION`);
console.log(`  median best vertical shift: ${median} px = ${(median / pxPerPt).toFixed(2)} pt`);
console.log(`  (positive = our text sits ABOVE the source and must move down)`);
