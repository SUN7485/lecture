/**
 * No emitted text box may be buried under another one.
 *
 * This measures the boxes `write.js` ACTUALLY emits, which is not the same set
 * as the model's text objects: a line bound to a table row is emitted as one box
 * per CELL (`obj.tableSegments`), and those were the boxes colliding. An earlier
 * version of this probe read `obj.bbox` instead and reported the same 13 pairs
 * before and after the fix — it was measuring a correlated but different thing,
 * which is exactly the instrument fault EVO-033 describes.
 *
 * Every emitted box is `valign: middle`, so two boxes covering the same area draw
 * their text in the same place. Measured on the 118-page Unit Five deck: giving
 * every line in a multi-line cell the CELL's box produced 174 collisions over 21
 * pages, rendering `c=16` on top of `82`. Keeping each line's own y/h took that
 * to 27.
 *
 *   node experiments/verify-text-overlap.js --corpus
 *   node experiments/verify-text-overlap.js <file.pdf> [more.pdf ...]
 *   node experiments/verify-text-overlap.js --corpus --strict
 *   node experiments/verify-text-overlap.js --corpus --write-baseline
 */
import * as fs from "node:fs";
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { findPairs } from "../src/truth/corpus.js";
import { requireSubjects } from "./lib-gate.js";

/** Share of the SMALLER box that must be buried before it counts as a collision. */
const MAX_COVER = 0.6;
const BASELINE = "experiments/text-overlap-baseline.json";

/** Exactly what write.js iterates: table segments when it uses them, else the object. */
function emittedBoxes(page) {
  const out = [];
  for (const o of page.objects) {
    if (o.type !== "text" || !o.text) continue;
    const useSegments = o.tableSegments?.length && o.text === o.tableSourceText;
    if (useSegments) {
      for (const s of o.tableSegments) if (s.text) out.push({ text: s.text, bbox: s.bbox });
    } else {
      out.push({ text: o.text, bbox: o.bbox });
    }
  }
  return out.filter((b) => b.bbox?.w > 0 && b.bbox?.h > 0);
}

const cover = (a, b) => {
  const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (x <= 0 || y <= 0) return 0;
  return (x * y) / Math.min(a.w * a.h, b.w * b.h);
};

const STRICT = process.argv.includes("--strict");
const WRITE = process.argv.includes("--write-baseline");
const files = process.argv.includes("--corpus")
  ? findPairs().map((p) => ({ name: p.name, pdf: p.pdf }))
  : process.argv.slice(2).filter((a) => !a.startsWith("--"))
      .map((f) => ({ name: f.split(/[\\/]/).pop(), pdf: f }));

const prior = !STRICT && fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, "utf8")) : {};

let totalPairs = 0, totalPages = 0, worse = 0;
const current = {};

for (const f of files) {
  const model = modelFromPdf(f.pdf);
  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  let pairs = 0, pages = 0;
  const samples = [];
  for (const [i, page] of model.pages.entries()) {
    const boxes = emittedBoxes(page);
    let hit = 0;
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        if (cover(boxes[a].bbox, boxes[b].bbox) <= MAX_COVER) continue;
        hit++;
        if (samples.length < 4) {
          samples.push(`p${i + 1}  ${JSON.stringify(boxes[a].text.slice(0, 26))} <> ${JSON.stringify(boxes[b].text.slice(0, 26))}`);
        }
      }
    }
    if (hit) { pages++; pairs += hit; }
  }

  totalPairs += pairs; totalPages += pages;
  current[f.name] = pairs;
  const was = prior[f.name];
  const regressed = !STRICT && was != null && pairs > was;
  if (regressed) worse++;
  const verdict = STRICT ? (pairs ? "OVERLAP" : "ok")
    : regressed ? `WORSE (was ${was})`
    : was != null && pairs < was ? `better (was ${was})` : "ok";
  console.log(`  ${f.name.padEnd(28)} ${String(model.pages.length).padStart(4)} pages  ${String(pairs).padStart(4)} pair(s)  ${verdict}`);
  if (regressed || STRICT) for (const s of samples) console.log(`      ${s}`);
}

requireSubjects(totalPages, "pages", "check the paths, or the corpus root behind --corpus.");
console.log("=".repeat(78));
console.log(`  ${files.length} file(s) · ${totalPairs} overlapping text box(es) over ${totalPages} page(s)`);

if (WRITE) {
  fs.writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`\n  baseline written to ${BASELINE}`);
  process.exit(0);
}

if (STRICT) {
  const ok = totalPairs === 0;
  console.log(ok ? "\n  GATE PASS (strict): no emitted text box is buried under another."
                 : "\n  GATE FAIL (strict): text is drawn on top of text.");
  process.exit(ok ? 0 : 1);
}

// The DEFAULT is a regression gate. An absolute bar here would be permanently
// red — the corpus carries pre-existing overlaps of tightly-leaded em boxes that
// still render legibly — and a gate that can never pass is one everyone learns
// to ignore. `--strict` keeps the absolute bar available (EVO-019).
console.log(worse === 0 ? "\n  GATE PASS: no file has more overlapping text than its baseline."
                        : `\n  GATE FAIL: ${worse} file(s) got worse than baseline.`);
process.exit(worse === 0 ? 0 : 1);
