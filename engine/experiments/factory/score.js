/**
 * Score an extraction against the AUTHORED spec, per family.
 *
 * Matching is SPATIAL. Each item owns one row of the page, and an extracted
 * block is assigned to the row its baseline falls in — the text is never
 * consulted to decide which item a block belongs to. A text-similarity matcher
 * would assume the answer it is checking, and would quietly hide the two failure
 * modes that matter most here: a block that came out empty, and two items that
 * merged into one.
 *
 * REPORTED PER FAMILY, because a single percentage over mixed content says
 * nothing about which construct broke. A family at 0/4 with everything else at
 * 4/4 is a finding; the same numbers averaged are noise.
 *
 * Usage: node experiments/factory/score.js [pdf] [--verbose]
 */
import * as path from "node:path";
import { modelFromPdf } from "../../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { requireSubjects } from "../lib-gate.js";
import { SPEC, FAMILIES } from "./spec.js";
import { ROW_PITCH, TOP, PER_PAGE, FONT_PT } from "./build.js";

const PDF = process.argv[2] ?? ".work/factory/powerpoint.pdf";
const VERBOSE = process.argv.includes("--verbose");
/** Score the RAW extraction, before the doctor's repairs. The difference between
 *  the two runs is the repairs' own contribution — which is the only way to tell
 *  "the extractor read it wrong" from "a repair rewrote it". */
const RAW = process.argv.includes("--raw");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const model = modelFromPdf(path.resolve(PDF));
if (!RAW) for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

/** row index -> the blocks whose baseline lands in it */
const rows = new Map();
let placed = 0, strays = 0;
for (const [pi, page] of model.pages.entries()) {
  for (const o of page.objects) {
    if (o.type !== "text" || !norm(o.text)) continue;
    const centre = o.bbox.y + o.bbox.h / 2;
    const row = Math.round((centre - TOP - FONT_PT * 0.7) / ROW_PITCH);
    const idx = pi * PER_PAGE + row;
    if (row < 0 || row >= PER_PAGE || idx >= SPEC.length) { strays++; continue; }
    rows.set(idx, [...(rows.get(idx) ?? []), o]);
    placed++;
  }
}

const results = SPEC.map((s, i) => {
  const blocks = (rows.get(i) ?? []).sort((a, b) => a.bbox.x - b.bbox.x);
  const got = norm(blocks.map((b) => b.text).join(" "));
  const want = norm(s.text);
  return { ...s, got, want, blocks: blocks.length, exact: got === want };
});

requireSubjects(results.length, "spec items", "SPEC is empty.");

const chars = (a, b) => {
  // Longest common subsequence length / expected length — a recall number that
  // does not reward extra characters.
  const m = a.length, n = b.length;
  const dp = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    let prev = 0;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return n ? dp[n] / n : 1;
};

console.log(`\nSYNTHETIC GROUND TRUTH — ${path.basename(PDF)}`);
console.log(`  ${SPEC.length} authored items · ${placed} blocks matched to a row · ${strays} outside every row\n`);
console.log(`  family      exact   char recall   items`);
let exactAll = 0;
for (const f of FAMILIES) {
  const rs = results.filter((r) => r.family === f);
  const ex = rs.filter((r) => r.exact).length;
  exactAll += ex;
  const rec = rs.reduce((k, r) => k + chars(r.got, r.want), 0) / rs.length;
  const flag = ex === rs.length ? "" : "   <-";
  console.log(`  ${f.padEnd(10)}  ${String(ex).padStart(2)}/${String(rs.length).padEnd(2)}   ${(rec * 100).toFixed(2).padStart(6)}%       ${rs.length}${flag}`);
}
const recAll = results.reduce((k, r) => k + chars(r.got, r.want), 0) / results.length;
console.log(`  ${"TOTAL".padEnd(10)}  ${String(exactAll).padStart(2)}/${String(SPEC.length).padEnd(2)}   ${(recAll * 100).toFixed(2).padStart(6)}%`);

const bad = results.filter((r) => !r.exact);
if (bad.length) {
  console.log(`\n  ${bad.length} item(s) not reproduced exactly:`);
  for (const r of bad) {
    console.log(`\n    ${r.id}${r.note ? `  (${r.note})` : ""}   ${r.blocks} block(s)`);
    console.log(`      want ${JSON.stringify(r.want)}`);
    console.log(`      got  ${JSON.stringify(r.got)}`);
  }
}
if (VERBOSE) {
  console.log("\n  every item:");
  for (const r of results) console.log(`    ${r.exact ? "ok  " : "MISS"} ${r.id.padEnd(12)} ${JSON.stringify(r.got.slice(0, 56))}`);
}
