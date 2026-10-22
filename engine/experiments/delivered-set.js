/**
 * The per-block verbatim set of the text the user actually GETS.
 *
 * `verbatim-set.js` is the gate for an extraction change, and it stops one stage
 * too early. `convert` and the editor both apply DEFAULT_REPAIRS afterwards, so a
 * change can be +62/0 on raw extraction and still LOSE blocks at the endpoint —
 * measured, exactly that: the resolver gained a block raw and cost five
 * delivered, because a block it stopped rewriting was one the doctor used to be
 * able to finish. Raw said "no regression" and meant it, about the wrong stage.
 *
 * An audit has to terminate at the artifact the reader receives (EVO-030). This
 * one does: it builds the model the writer would write, applies the shipped
 * repairs, and reports the verbatim verdict per block.
 *
 * Blocks are keyed by page and geometry rather than by object id, so the identity
 * survives a change that renumbers objects — the same reason `verbatim-set` keys
 * on geometry.
 *
 * Usage:
 *   node experiments/delivered-set.js > before.txt
 *   node experiments/delivered-set.js > after.txt
 *   node experiments/delivered-set.js --diff before.txt after.txt
 *   node experiments/delivered-set.js --text > before.txt   # byte identity
 */
import * as fs from "node:fs";
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";

if (process.argv[2] === "--diff") {
  const parse = (f) => new Map(
    fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("\t");
      return [l.slice(i + 1), l.slice(0, i) === "1"];
    })
  );
  const before = parse(process.argv[3]);
  const after = parse(process.argv[4]);

  const fixed = [], broken = [], appeared = [], vanished = [];
  for (const [k, wasOk] of before) {
    if (!after.has(k)) { vanished.push(k); continue; }
    if (!wasOk && after.get(k)) fixed.push(k);
    if (wasOk && !after.get(k)) broken.push(k);
  }
  for (const k of after.keys()) if (!before.has(k)) appeared.push(k);
  const vanishedOk = vanished.filter((k) => before.get(k)).length;

  console.log(`DELIVERED (after ${DEFAULT_REPAIRS.join(" + ")})`);
  console.log(`blocks before ${before.size}   after ${after.size}`);
  console.log(`  FIXED    (miss -> verbatim): ${fixed.length}`);
  console.log(`  BROKEN   (verbatim -> miss): ${broken.length}`);
  console.log(`  appeared (new block key):    ${appeared.length}`);
  console.log(`  vanished (block key gone):   ${vanished.length}  (of which were verbatim: ${vanishedOk})`);
  if (broken.length) {
    console.log("\nREGRESSIONS — delivered verbatim before, not any more:");
    for (const k of broken.slice(0, 25)) console.log(`  ${k}`);
    if (broken.length > 25) console.log(`  ...and ${broken.length - 25} more`);
  }
  const net = fixed.length - broken.length - vanishedOk;
  console.log(`\nnet ${net >= 0 ? "+" : ""}${net} delivered blocks`);
  console.log(broken.length === 0 ? "GATE PASS: no delivered block regressed." : "GATE FAIL: see regressions above.");
  process.exit(broken.length === 0 ? 0 : 1);
}

const TEXT = process.argv[2] === "--text";

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  const slides = loadSlides(pair.html);
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(
    model.pages.map((p) => normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" "))),
    slideText);

  for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

  for (const [i, p] of model.pages.entries()) {
    for (const o of p.objects) {
      if (o.type !== "text" || !o.text) continue;
      // `baselinePt` and the bbox left edge, which is what verbatim-set keys on
      // too. A text object has no top-level x/y — those live in `bbox` — and the
      // first version of this key read `o.y ?? 0`, so 10153 blocks collapsed into
      // 616 buckets and the gate reported "0 broken" over a set that had lost
      // nine tenths of its members. A key that silently collides is a gate that
      // silently passes.
      const key = `${pair.name} p${i + 1} y=${(o.baselinePt ?? 0).toFixed(1)} x=${(o.bbox?.x ?? 0).toFixed(1)}`;
      if (TEXT) { console.log(`${key}\t${o.text}`); continue; }
      // Pages with no slide behind them cannot be scored, and are omitted rather
      // than counted as misses — the same rule verbatim-set uses.
      if (align[i] < 0) continue;
      console.log(`${slideText[align[i]].includes(normalize(o.text)) ? 1 : 0}\t${key}`);
    }
  }
}
