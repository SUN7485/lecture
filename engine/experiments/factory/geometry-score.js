/**
 * Placement, scored against authored truth, at the DELIVERED package.
 *
 *   THE FIRST GEOMETRY INVARIANT
 *   Correct content at the wrong anchor is a FAILURE.
 *
 * WHY IT TERMINATES AT THE PPTX. `«78»` was correct in the model and 125pt wrong
 * on the slide, because the writer centred it in a cell the source right-anchors.
 * A geometry axis that stops at the model would have called that page perfect —
 * so this reads the boxes out of the package the user receives (EVO-030).
 *
 * WHY NOT IoU. Two boxes can overlap heavily and still be anchored to opposite
 * edges; whole-page ink IoU said the `«78»` page was fine because the ink was
 * still on it. Every delta below is SIGNED and per-edge, so "the right size in
 * the wrong place" and "the right place at the wrong size" are different rows.
 *
 * WHAT IS COMPARED
 *   authored     x, y, w, h, anchor, fontSize, rotation      geometry-spec.js
 *   delivered    the shape's box in the .pptx                the artifact
 *   Δleft Δright Δtop Δbottom ΔcenterX Δwidth Δheight
 *   anchorError  the delta at the edge the ITEM is anchored to — the number
 *                that matters, because an anchored edge is the one the source
 *                promised and the opposite edge is free to absorb shaping drift
 *   rotationError
 *
 * Matching is by BASELINE ROW then by authored x, never by text — the same rule
 * the text factory follows and for the same reason.
 *
 * Usage: node experiments/factory/geometry-score.js [pdf] [--verbose]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { modelFromPdf } from "../../src/model/normalize.js";
import { writePptx } from "../../src/pptx/write.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { requireSubjects } from "../lib-gate.js";
import { GEOMETRY, GEOMETRY_FAMILIES, PAGE } from "./geometry-spec.js";

const PDF = path.resolve(process.argv[2] ?? ".work/factory/geometry.pdf");
const VERBOSE = process.argv.includes("--verbose");
const EMU = 12700;
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const model = modelFromPdf(PDF);
for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

const out = path.join(path.dirname(PDF), "geometry-delivered.pptx");
await writePptx(model, out);

/** Every text shape's box, read out of the package the user receives. */
const zip = await JSZip.loadAsync(fs.readFileSync(out));
const xml = await zip.file("ppt/slides/slide1.xml").async("string");
const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const shapes = [];
for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? []) {
  const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
  const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
  const t = (sp.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? []).map((v) => dec(v.replace(/<\/?a:t>/g, ""))).join("");
  if (!off || !ext || !norm(t)) continue;
  const rot = sp.match(/<a:xfrm[^>]*\brot="(-?\d+)"/);
  shapes.push({
    text: norm(t),
    x: +off[1] / EMU, y: +off[2] / EMU, w: +ext[1] / EMU, h: +ext[2] / EMU,
    rotation: rot ? -(+rot[1]) / 60000 : 0,
    algn: (sp.match(/<a:pPr[^>]*\balgn="(\w+)"/) ?? [, null])[1],
  });
}

/** Assign each delivered shape to the authored item whose row and x it lands in. */
const used = new Set();
const results = GEOMETRY.map((g) => {
  let best = null, bestD = Infinity;
  for (const [i, s] of shapes.entries()) {
    if (used.has(i)) continue;
    // ROW first: an item owns a horizontal band, so a shape one row away can
    // never be claimed by it however close its x happens to be.
    if (Math.abs((s.y + s.h / 2) - (g.y + g.h / 2)) > g.h) continue;
    const d = Math.abs(s.x - g.x);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best == null) return { ...g, missing: true };
  used.add(best);
  const s = shapes[best];
  const dLeft = s.x - g.x;
  const dRight = (s.x + s.w) - (g.x + g.w);
  const anchorError = g.anchor === "left" ? dLeft
    : g.anchor === "right" ? dRight
    : (s.x + s.w / 2) - (g.x + g.w / 2);
  return {
    ...g, missing: false, got: s,
    dLeft, dRight,
    dTop: s.y - g.y, dBottom: (s.y + s.h) - (g.y + g.h),
    dCentreX: (s.x + s.w / 2) - (g.x + g.w / 2),
    dWidth: s.w - g.w, dHeight: s.h - g.h,
    anchorError, rotationError: (s.rotation ?? 0) - (g.rotation ?? 0),
  };
});

requireSubjects(results.length, "geometry items", "GEOMETRY is empty.");

/**
 * The bar is the EM, not a fixed point count. A 7pt line and a 22pt line do not
 * have the same idea of "close", and this project has already been burned by a
 * flat threshold applied across a scaled page (`tiny-text`, 1455 findings).
 */
const TOL_EM = 0.5;
const fail = (r) => r.missing || Math.abs(r.anchorError) > TOL_EM * r.fontSize
  || Math.abs(r.rotationError) > 0.5;

console.log(`\nGEOMETRY GROUND TRUTH — ${path.basename(PDF)}  ->  delivered .pptx`);
console.log(`  ${GEOMETRY.length} authored objects · ${shapes.length} delivered text shapes · page ${PAGE.w}x${PAGE.h}pt`);
console.log(`  a miss is |anchorError| > ${TOL_EM} em, a rotation off by > 0.5 deg, or no shape at all\n`);
console.log(`  family      pass   |anchorErr| p50   p90     max     items`);
let passAll = 0;
for (const f of GEOMETRY_FAMILIES) {
  const rs = results.filter((r) => r.family === f);
  const ok = rs.filter((r) => !fail(r)).length;
  passAll += ok;
  const errs = rs.filter((r) => !r.missing).map((r) => Math.abs(r.anchorError)).sort((a, b) => a - b);
  const q = (p) => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * p))] : NaN);
  console.log(`  ${f.padEnd(10)}  ${String(ok).padStart(2)}/${String(rs.length).padEnd(2)}` +
    `   ${q(0.5).toFixed(2).padStart(8)}  ${q(0.9).toFixed(2).padStart(6)}  ${(errs.length ? errs[errs.length - 1] : NaN).toFixed(2).padStart(6)}    ${rs.length}` +
    `${ok === rs.length ? "" : "   <-"}`);
}
console.log(`  ${"TOTAL".padEnd(10)}  ${String(passAll).padStart(2)}/${String(GEOMETRY.length).padEnd(2)}`);

const bad = results.filter(fail);
if (bad.length) {
  console.log(`\n  ${bad.length} object(s) misplaced:`);
  for (const r of bad) {
    if (r.missing) { console.log(`    ${r.id.padEnd(12)} NO DELIVERED SHAPE  ${JSON.stringify(r.text)}`); continue; }
    console.log(`    ${r.id.padEnd(12)} anchor=${r.anchor.padEnd(6)} anchorErr ${r.anchorError.toFixed(2).padStart(8)}pt ` +
      `(${(r.anchorError / r.fontSize).toFixed(2)} em)  ${JSON.stringify(r.text.slice(0, 24))}`);
    console.log(`      Δleft ${r.dLeft.toFixed(2)}  Δright ${r.dRight.toFixed(2)}  ΔcentreX ${r.dCentreX.toFixed(2)}` +
      `  Δwidth ${r.dWidth.toFixed(2)}  Δtop ${r.dTop.toFixed(2)}  Δheight ${r.dHeight.toFixed(2)}` +
      `  Δrot ${r.rotationError.toFixed(2)}`);
  }
}
if (VERBOSE) {
  console.log("\n  every object:");
  for (const r of results) {
    console.log(`    ${fail(r) ? "MISS" : "ok  "} ${r.id.padEnd(12)} ${r.missing ? "(none)" :
      `anchorErr ${r.anchorError.toFixed(2)}pt  Δw ${r.dWidth.toFixed(2)}`}`);
  }
}
process.exit(bad.length ? 1 : 0);
