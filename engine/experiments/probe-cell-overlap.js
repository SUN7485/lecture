/** Do two cell segments of one line ever overlap now that the box is the ink? */
import * as path from "node:path";
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { findPairs } from "../src/truth/corpus.js";

const files = [...findPairs().map((p) => p.pdf), ...process.argv.slice(2)];
let pairs = 0, overlaps = 0, lines = 0, segs = 0;
const worst = [];
for (const pdf of files) {
  const name = path.basename(pdf).replace(/\.pdf$/i, "");
  let model; try { model = modelFromPdf(pdf); } catch { continue; }
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
  for (const [pi, page] of model.pages.entries()) {
    for (const o of page.objects) {
      const S = o.tableSegments;
      if (o.type !== "text" || !S?.length || o.text !== o.tableSourceText) continue;
      lines++; segs += S.length;
      for (let a = 0; a < S.length; a++) for (let b = a + 1; b < S.length; b++) {
        pairs++;
        const A = S[a].bbox, B = S[b].bbox;
        const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
        const oy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
        if (ox > 0.5 && oy > 0.5) {
          overlaps++;
          worst.push({ ox, name, page: pi + 1, a: S[a].text.slice(0, 18), b: S[b].text.slice(0, 18) });
        }
      }
    }
  }
}
console.log(`\nCELL SEGMENT OVERLAP — ${files.length} docs · ${lines} split lines · ${segs} segments · ${pairs} pairs`);
console.log(`  overlapping pairs (>0.5pt in both axes): ${overlaps}`);
for (const w of worst.sort((a, b) => b.ox - a.ox).slice(0, 8))
  console.log(`    ${w.ox.toFixed(1)}pt  ${w.name} p${w.page}  ${JSON.stringify(w.a)} / ${JSON.stringify(w.b)}`);
