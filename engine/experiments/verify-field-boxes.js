/**
 * Does the text still sit inside the box the source drew around it?
 *
 * The source puts inline "chips" around spreadsheet calls — a small rounded box
 * around `=STDEV.P()` in the middle of an Arabic sentence. The box is a shape at
 * absolute coordinates; the token is a fragment of a line whose internal layout
 * belongs to PowerPoint. If the two disagree the box cuts through its own text,
 * which is the single most visible defect this converter can ship.
 *
 * This measures it in the RENDER, not in the model — in the model the text is
 * always inside the box, which is exactly why the bug survived every structural
 * check. For each site it asks one question: does text ink cross the box's
 * vertical borders?
 *
 *   node experiments/verify-field-boxes.js <pdf> <renderDir> [widthPx]
 *
 * `renderDir` holds slide-001.png… as produced by src/render/powerpoint.js.
 */
import * as path from "node:path";
import { modelFromPdf } from "../src/model/normalize.js";
import { renderPdfPage, readPng, inkMask } from "../src/render/compare.js";

const PDF = process.argv[2] ?? "C:/Users/mosun/Downloads/final lecs/chp1/done/Chp1-Lec4-2.pdf";
const DIR = process.argv[3] ?? "out/render";
const WIDTH = Number(process.argv[4] ?? 1600);

/** Ink that spills this far past a border is a real defect, not antialiasing. */
const SPILL_PT = 3;

/** A box that encloses only part of a line — the at-risk case. */
function sites(page) {
  const shapes = page.objects.filter((o) => o.type === "shape");
  const texts = page.objects.filter((o) => o.type === "text");
  const out = [];
  for (const s of shapes) {
    for (const t of texts) {
      const vOverlap = Math.min(t.bbox.y + t.bbox.h, s.bbox.y + s.bbox.h) - Math.max(t.bbox.y, s.bbox.y);
      if (vOverlap <= 2) continue;
      if (t.bbox.x < s.bbox.x - 1 && t.bbox.x + t.bbox.w > s.bbox.x + s.bbox.w + 1 && t.bbox.w > s.bbox.w * 1.6) {
        out.push({ shape: s, text: t });
      }
    }
  }
  // Fill and stroke are drawn as two shapes at the same rect; measure each once.
  const seen = new Set();
  return out.filter((s) => {
    const k = `${s.shape.bbox.x.toFixed(1)},${s.shape.bbox.y.toFixed(1)},${s.shape.bbox.w.toFixed(1)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Contiguous groups of text ink in the box's row band, in points.
 *
 * Groups, not raw columns: the FIRST version of this check measured "any ink
 * within 40pt of the border", which is the neighbouring words on the same line
 * and therefore reported the same ~40pt for a correct render and one that was
 * 31.6pt broken. A gate that returns one value for everything is not a gate
 * (EVO-024). What matters is the extent of the ONE group that belongs to this
 * box, so the token is identified by overlap and then measured against the
 * border. A group is also the right unit because losing the space that separates
 * the token from the next word is part of the defect: the two merge.
 */
function textInk(img, box, pxPerPt) {
  const y0 = Math.round((box.y + box.h * 0.2) * pxPerPt);
  const y1 = Math.round((box.y + box.h * 0.8) * pxPerPt);
  const h = y1 - y0;
  const mask = inkMask(img);
  const cols = [];
  for (let x = 0; x < img.width; x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (mask[y * img.width + x]) n++;
    const pt = x / pxPerPt;
    const onBorder =
      (Math.abs(pt - box.x) < 1.5 || Math.abs(pt - (box.x + box.w)) < 1.5) && n >= h * 0.7;
    if (n > 0 && !onBorder) cols.push(pt);
  }
  // Columns -> groups separated by a real word gap.
  const GAP_PT = 1.8;
  const groups = [];
  for (const c of cols) {
    const last = groups[groups.length - 1];
    if (last && c - last[1] <= GAP_PT) last[1] = c;
    else groups.push([c, c]);
  }
  return groups;
}

/** How far the group that belongs to this box sticks out past its borders. */
function spillOf(groups, box) {
  const x1 = box.x + box.w;
  let best = null, bestOverlap = 0;
  for (const g of groups) {
    const ov = Math.min(g[1], x1) - Math.max(g[0], box.x);
    if (ov > bestOverlap) { bestOverlap = ov; best = g; }
  }
  if (!best) return { spill: 0, group: null };
  return { spill: Math.max(0, box.x - best[0], best[1] - x1), group: best };
}

const model = modelFromPdf(PDF);
const pxPerPt = WIDTH / model.pages[0].widthPt;

let total = 0, bad = 0;
const rows = [];

for (const [pi, page] of model.pages.entries()) {
  const list = sites(page);
  if (!list.length) continue;
  const png = path.join(DIR, `slide-${String(pi + 1).padStart(3, "0")}.png`);
  let img;
  try { img = readPng(png); } catch { console.error(`missing render: ${png}`); continue; }
  const ref = renderPdfPage(PDF, pi, img.width);

  for (const { shape } of list) {
    total++;
    const b = shape.bbox;
    const ourSpill = spillOf(textInk(img, b, pxPerPt), b).spill;
    const srcSpill = spillOf(textInk(ref, b, pxPerPt), b).spill;
    // The source is the standard, not zero: a chip whose own token sits a hair
    // proud of the border in the PDF is not our defect.
    const fail = ourSpill > srcSpill + SPILL_PT;
    if (fail) bad++;
    rows.push({ page: pi + 1, box: `${b.x.toFixed(1)}..${(b.x + b.w).toFixed(1)}`, ourSpill, srcSpill, fail });
  }
}

console.log(`FIELD BOXES — does the text stay inside its chip?  ${path.basename(PDF)}`);
console.log("=".repeat(66));
for (const r of rows) {
  console.log(
    `  ${r.fail ? "[FAIL]" : "[ ok ]"} p${String(r.page).padStart(2)}  box ${r.box.padEnd(16)}` +
    `ours ${r.ourSpill.toFixed(1).padStart(5)}pt   source ${r.srcSpill.toFixed(1).padStart(5)}pt`
  );
}
console.log("=".repeat(66));
console.log(`  ${total - bad}/${total} sites clean` + (bad ? `  — ${bad} FAIL` : ""));
process.exit(bad ? 1 : 0);
