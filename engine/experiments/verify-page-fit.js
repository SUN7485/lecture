/**
 * The page -> slide transform must come from the PHYSICAL page box, never from
 * where the content happens to land.
 *
 * WHY THIS GATE EXISTS. A 118-page merged lecture was reported as "slides 64-94
 * are globally scaled and repositioned, large white areas appear, slide 95 is
 * fine again". The transform was correct: that PDF carries three physical page
 * geometries (713.04x487.92 for pages 1-63 and 95-118, 750x749.04 for 64-78,
 * 750x751.92 for 79-94), a PowerPoint presentation has exactly ONE slide size,
 * and the odd pages can only be scaled uniformly and centred. Nothing was wrong
 * and it still cost a session to prove, because no gate could state the rule.
 *
 * This one states it. Every assertion below is a property of `fitPagesToCanvas`
 * alone, so it runs with no corpus and cannot rot:
 *
 *   1  the canvas IS the physical size of the most common page group
 *   2  a page whose physical size equals the canvas is untouched: scale 1, no offset
 *   3  the scale is UNIFORM — one factor for both axes, so nothing is distorted
 *   4  two pages of equal physical size receive an identical transform
 *   5  the transform is a function of the page BOX only: adding, moving or
 *      removing content on a page cannot change it
 *   6  the fitted page is centred: the source edges map to
 *      [offsetX, offsetX + w*scale] and that interval sits inside the canvas
 *   7  no page is ever scaled ABOVE 1 to fill the canvas, and none is scaled
 *      down unless its own box is larger than the canvas in some axis
 *
 * Optionally takes real PDFs and asserts the same invariants on their model,
 * plus the one property a synthetic list cannot express: that a run of equal
 * physical page sizes produces a run of equal transforms.
 *
 * Usage: node experiments/verify-page-fit.js [file.pdf ...]
 *        node experiments/verify-page-fit.js --seed-regression   (proves it fails)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fitPagesToCanvas, modelFromPdf } from "../src/model/normalize.js";

const SEED = process.argv.includes("--seed-regression");
const FILES = process.argv.slice(2).filter((a) => !a.startsWith("--") && fs.existsSync(a));
const EPS = 0.01;

let failures = 0;
const check = (ok, what, detail = "") => {
  if (ok) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `  ${detail}` : ""}`);
};

/** A page as `fitPagesToCanvas` consumes it: a box plus objects it must not read. */
const page = (w, h, objects = []) => ({ widthPt: w, heightPt: h, objects, tables: [] });
const obj = (x, y, w, h) => ({ type: "text", bbox: { x, y, w, h }, runs: [{ fontSizePt: 12 }] });

console.log("\nPAGE FIT INVARIANTS — the transform is a property of the page box\n");

// ---- 1, 2, 3, 7: a single page size is the canvas and nothing moves ---------
{
  const pages = [page(713.04, 487.92, [obj(10, 10, 100, 20)]), page(713.04, 487.92)];
  const fit = fitPagesToCanvas(pages);
  check(Math.abs(fit.widthPt - 713.04) < EPS && Math.abs(fit.heightPt - 487.92) < EPS,
    "canvas is the only page size", `got ${fit.widthPt}x${fit.heightPt}`);
  check(fit.fittedPages === 0, "nothing is fitted when every page matches", `fittedPages=${fit.fittedPages}`);
  for (const p of pages) {
    check(Math.abs(p.sourceFit.scale - 1) < 1e-6, "an unfitted page keeps scale 1", `scale=${p.sourceFit.scale}`);
    check(Math.abs(p.sourceFit.x) < EPS && Math.abs(p.sourceFit.y) < EPS, "an unfitted page keeps offset 0");
  }
  check(Math.abs(pages[0].objects[0].bbox.x - 10) < EPS && Math.abs(pages[0].objects[0].bbox.y - 10) < EPS,
    "an unfitted page's objects are untouched", JSON.stringify(pages[0].objects[0].bbox));
}

// ---- 1, 4, 6, 7: the dominant group wins and the odd pages are centred ------
{
  // The reported document's own shape: 87 landscape, 31 near-square.
  const pages = [];
  for (let i = 0; i < 63; i++) pages.push(page(713.04, 487.92));
  for (let i = 0; i < 15; i++) pages.push(page(750, 749.04));
  for (let i = 0; i < 16; i++) pages.push(page(750, 751.92));
  for (let i = 0; i < 24; i++) pages.push(page(713.04, 487.92));
  const fit = fitPagesToCanvas(pages);

  check(Math.abs(fit.widthPt - 713.04) < EPS && Math.abs(fit.heightPt - 487.92) < EPS,
    "canvas is the MOST COMMON page size, not the largest", `got ${fit.widthPt}x${fit.heightPt}`);
  check(fit.fittedPages === 31, "exactly the odd pages are fitted", `fittedPages=${fit.fittedPages}`);

  for (const [i, p] of pages.entries()) {
    const s = p.sourceFit;
    // The PHYSICAL box, not p.widthPt — fitPagesToCanvas overwrites that with the
    // canvas, so reading it back makes every assertion compare the canvas to itself.
    const bw = p.sourceSizePt.widthPt, bh = p.sourceSizePt.heightPt;
    const expected = Math.min(fit.widthPt / bw, fit.heightPt / bh);
    check(Math.abs(s.scale - expected) < 1e-4, `p${i + 1} scale is min(canvas/box) in both axes`, `${s.scale} vs ${expected}`);
    check(s.scale <= 1 + 1e-9, `p${i + 1} is never scaled UP to fill the canvas`, `scale=${s.scale}`);
    // Centred, and inside the canvas: the mapped source edges are the whole story.
    const right = s.x + bw * s.scale, bottom = s.y + bh * s.scale;
    check(Math.abs(s.x - (fit.widthPt - bw * s.scale) / 2) < EPS, `p${i + 1} is centred horizontally`);
    check(Math.abs(s.y - (fit.heightPt - bh * s.scale) / 2) < EPS, `p${i + 1} is centred vertically`);
    check(s.x >= -EPS && s.y >= -EPS && right <= fit.widthPt + EPS && bottom <= fit.heightPt + EPS,
      `p${i + 1} maps inside the canvas`, `${s.x},${s.y}..${right},${bottom}`);
  }

  // 4: equal boxes, equal transforms — the whole "why did slide 64 differ from 63"
  // question, stated as an invariant.
  //
  // Key on sourceSizePt, NOT on widthPt/heightPt: fitPagesToCanvas overwrites
  // those with the CANVAS size, so keying on them collapses every page into one
  // bucket and the assertion compares a fitted page against an unfitted one.
  // (Caught by this gate failing 124 times on its first run — EVO-033's colliding
  // key, one level down.)
  const key = (p) => `${p.sourceSizePt.widthPt}x${p.sourceSizePt.heightPt}`;
  const seen = new Map();
  for (const [i, p] of pages.entries()) {
    const k = key(p), prev = seen.get(k);
    if (!prev) { seen.set(k, { i, fit: p.sourceFit }); continue; }
    check(Math.abs(prev.fit.scale - p.sourceFit.scale) < 1e-9 &&
          Math.abs(prev.fit.x - p.sourceFit.x) < 1e-9 && Math.abs(prev.fit.y - p.sourceFit.y) < 1e-9,
      `p${i + 1} and p${prev.i + 1} have the same box so must have the same transform`,
      `${JSON.stringify(p.sourceFit)} vs ${JSON.stringify(prev.fit)}`);
  }
}

// ---- 5: content cannot influence the transform ------------------------------
{
  const bare = [page(713.04, 487.92), page(750, 749.04)];
  const full = [page(713.04, 487.92), page(750, 749.04, [obj(0, 0, 1, 1), obj(700, 700, 40, 40)])];
  const tiny = [page(713.04, 487.92), page(750, 749.04, [obj(300, 300, 2, 2)])];
  const fits = [bare, full, tiny].map((ps) => { fitPagesToCanvas(ps); return ps[1].sourceFit; });
  check(fits.every((f) => Math.abs(f.scale - fits[0].scale) < 1e-9 &&
                          Math.abs(f.x - fits[0].x) < 1e-9 && Math.abs(f.y - fits[0].y) < 1e-9),
    "the transform ignores content extents entirely", JSON.stringify(fits));
}

// ---- 3 again, explicitly: no anisotropic scaling ----------------------------
{
  const pages = [page(713.04, 487.92), page(750, 749.04, [obj(0, 0, 100, 100)])];
  fitPagesToCanvas(pages);
  const o = pages[1].objects[0].bbox;
  check(Math.abs(o.w - o.h) < EPS, "a square object stays square after fitting", `${o.w}x${o.h}`);
}

// ---- the seeded regression, to prove this gate can fail ---------------------
if (SEED) {
  console.log("\n  --seed-regression: asserting a DELIBERATELY wrong expectation");
  const pages = [page(713.04, 487.92), page(750, 749.04)];
  fitPagesToCanvas(pages);
  check(Math.abs(pages[1].sourceFit.scale - 1) < 1e-6,
    "SEEDED: a square page fitted into a landscape canvas keeps scale 1 (it must not)",
    `scale=${pages[1].sourceFit.scale}`);
}

// ---- real documents, if any were supplied -----------------------------------
for (const file of FILES) {
  const name = path.basename(file);
  const model = modelFromPdf(file);
  const canvas = model.document.slideSizePt;
  console.log(`\n  ${name} — ${model.pages.length} pages, canvas ${canvas.width}x${canvas.height}`);

  const runs = [];
  for (const p of model.pages) {
    const k = `${p.sourceSizePt.widthPt}x${p.sourceSizePt.heightPt}`;
    const last = runs[runs.length - 1];
    if (last && last.key === k) last.to = p.index; else runs.push({ key: k, from: p.index, to: p.index, fit: p.sourceFit });
  }
  for (const r of runs) console.log(`     pages ${String(r.from + 1).padStart(3)}-${String(r.to + 1).padStart(3)}  box ${r.key.padEnd(16)} scale ${r.fit.scale}  offset ${r.fit.x},${r.fit.y}`);

  const byBox = new Map();
  for (const p of model.pages) {
    const k = `${p.sourceSizePt.widthPt}x${p.sourceSizePt.heightPt}`;
    const prev = byBox.get(k);
    if (!prev) { byBox.set(k, p); continue; }
    check(prev.sourceFit.scale === p.sourceFit.scale && prev.sourceFit.x === p.sourceFit.x && prev.sourceFit.y === p.sourceFit.y,
      `${name} p${p.index}: same physical box as p${prev.index} must give the same transform`,
      `${JSON.stringify(p.sourceFit)} vs ${JSON.stringify(prev.sourceFit)}`);
    const expected = Math.min(canvas.width / p.sourceSizePt.widthPt, canvas.height / p.sourceSizePt.heightPt);
    check(Math.abs(p.sourceFit.scale - expected) < 1e-4,
      `${name} p${p.index}: scale follows from the page box alone`, `${p.sourceFit.scale} vs ${expected}`);
  }
}

console.log(failures ? `\nGATE FAIL: ${failures} broken invariant(s).\n` : "\nGATE PASS: the page transform is a function of the physical page box.\n");
process.exit(failures ? 1 : 0);
