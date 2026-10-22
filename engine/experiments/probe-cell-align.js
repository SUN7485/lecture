/**
 * WHERE THE SOURCE PUTS A TABLE CELL'S TEXT, and how far our centring moves it.
 *
 * Reads production's own `srcInk` off each table segment rather than
 * re-deriving it (EVO-033), and compares it against the box the writer emits.
 */
import * as path from "node:path";
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { findPairs } from "../src/truth/corpus.js";

const files = [...findPairs().map((p) => p.pdf), ...process.argv.slice(2)];
const rows = [];

for (const pdf of files) {
  const name = path.basename(pdf).replace(/\.pdf$/i, "");
  let model;
  try { model = modelFromPdf(pdf); } catch (e) { console.log(`SKIP ${name}: ${e.message}`); continue; }
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
  for (const [pi, page] of model.pages.entries()) {
    for (const o of page.objects) {
      if (o.type !== "text" || !o.tableSegments?.length) continue;
      if (o.text !== o.tableSourceText) continue;      // only the ones the writer uses
      for (const seg of o.tableSegments) {
        if (!seg.srcInk || seg.srcInk.w <= 0) continue;
        const boxL = seg.bbox.x, boxW = seg.bbox.w;
        const inkL = seg.srcInk.x, inkW = seg.srcInk.w;
        const padL = inkL - boxL;
        const padR = (boxL + boxW) - (inkL + inkW);
        // Where CENTRING puts the same ink, which is what ships today.
        const centredL = boxL + (boxW - inkW) / 2;
        rows.push({
          name, page: pi + 1, text: seg.text, boxW, inkW, padL, padR,
          shift: centredL - inkL, slack: boxW - inkW,
        });
      }
    }
  }
}

const q = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const abs = rows.map((r) => Math.abs(r.shift));
console.log(`\nTABLE CELL PLACEMENT — ${rows.length} cell segments over ${files.length} documents\n`);
console.log(`  displacement caused by centring (pt)`);
console.log(`    p50 ${q(abs, 0.5).toFixed(2)}   p90 ${q(abs, 0.9).toFixed(2)}   p99 ${q(abs, 0.99).toFixed(2)}   max ${Math.max(...abs).toFixed(2)}`);
for (const t of [1, 2, 5, 10, 20, 50, 100]) {
  const n = abs.filter((v) => v > t).length;
  console.log(`    > ${String(t).padStart(3)}pt : ${String(n).padStart(5)}  (${((n / rows.length) * 100).toFixed(2)}%)`);
}

// Which edge is the source actually anchored to?
const TOL = 1.5;
const cls = (r) => {
  if (r.slack <= 2 * TOL) return "TIGHT (no room to differ)";
  if (Math.abs(r.padL - r.padR) <= TOL) return "centred";
  return r.padL < r.padR ? "left" : "right";
};
const tally = new Map();
for (const r of rows) tally.set(cls(r), (tally.get(cls(r)) ?? 0) + 1);
console.log(`\n  source anchor, by cell`);
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(n).padStart(5)}  ${k}`);

console.log(`\n  WORST 12 by displacement`);
for (const r of rows.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)).slice(0, 12))
  console.log(`    ${Math.abs(r.shift).toFixed(1).padStart(6)}pt  ${cls(r).padEnd(24)} box ${r.boxW.toFixed(0)} ink ${r.inkW.toFixed(0)}  ${r.name} p${r.page}  ${JSON.stringify(r.text.slice(0, 26))}`);
