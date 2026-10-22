/**
 * End-to-end check: does the generated PPTX contain what the model intended,
 * and does its Arabic survive the round trip through OOXML?
 */
import { inspectPptx, summarize } from "../src/pptx/inspect.js";
import { modelFromPdf } from "../src/model/normalize.js";
import { normalize } from "../src/truth/html-slides.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";

// The deck `convert` actually writes. The old default was `out/Lec6-2.pptx`, a
// name from an earlier naming scheme, so this reported a stale artifact — NONE
// embedded, 91% round trip — about a build that was fine.
const PPTX = process.argv[2] ?? "out/Chp1-Lec6-2.pptx";
const PDF = process.argv[3] ?? "C:/Users/mosun/Downloads/final lecs/chp1/done/Chp1-Lec6-2.pdf";

// "Intended" must mean what `convert` intended, not what a raw re-extraction
// says. `convert` repairs backwards formula calls by default, so a reference
// model that skips the repair reports the repaired paragraphs as MISSING from
// the deck — Chp1-Lec4-2 scored 99.01% for four paragraphs that were correct.
const model = modelFromPdf(PDF);
for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

// What the model MEANT to deliver as pictures. Distinct refs, because the cache
// is content-addressed: one logo on twenty pages is one file and one media part.
const deliverable = model.pages.flatMap((p) =>
  p.objects.filter((o) => o.type === "image" && o.ref && o.reconstructionStrategy !== "degenerate"));
const imagesIntended = new Set(deliverable.map((o) => o.ref)).size;
const slideArea = model.pages[0].widthPt * model.pages[0].heightPt;
const sourceMaxCoverage = Math.max(0,
  ...deliverable.map((o) => (o.bbox.w * o.bbox.h) / slideArea));

const report = await inspectPptx(PPTX);
const { lines, gates, pass } = summarize(report, {
  slideSizePt: { w: model.pages[0].widthPt, h: model.pages[0].heightPt },
  imagesIntended,
  sourceMaxCoverage,
});

console.log("PPTX FORENSICS");
console.log("=".repeat(58));
for (const l of lines) console.log("  " + l);

// Does every paragraph we meant to write actually appear in the XML?
let intended = 0, present = 0;
const missing = [];
for (const [i, page] of model.pages.entries()) {
  const raw = report.slides[i]?.texts ?? [];
  // Join two ways: runs are separate <a:t> elements, so a run boundary inside a
  // word makes a space-joined comparison fail even when the text is perfect.
  const spaced = normalize(raw.join(" "));
  const tight = normalize(raw.join(""));
  for (const obj of page.objects) {
    if (!obj.text) continue;
    intended++;
    const want = normalize(obj.text);
    if (spaced.includes(want) || tight.includes(want)) present++;
    else missing.push(`p${i + 1}: ${obj.text.slice(0, 60)}`);
  }
}

console.log("\nTEXT ROUND TRIP (model -> OOXML)");
console.log("=".repeat(58));
console.log(`  intended paragraphs : ${intended}`);
console.log(`  found in slide XML  : ${present}  (${((present / intended) * 100).toFixed(2)}%)`);
if (missing.length) {
  console.log(`  missing: ${missing.length}`);
  for (const m of missing.slice(0, 5)) console.log(`    ${m}`);
}

console.log("\nGATES");
console.log("=".repeat(58));
// `null` is "not applicable to this document" — never printed as PASS, or the
// vacuous-truth hole that the gate's own `> 0` guard exists to close comes back.
for (const [name, ok] of gates) console.log(`  [${ok === null ? "n/a " : ok ? "PASS" : "FAIL"}] ${name}`);
console.log(`\n  overall: ${pass ? "PASS" : "FAIL"}`);
