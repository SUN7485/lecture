/**
 * For every lam-alef case: is RAW right, is MODEL right, and who broke it?
 *
 * Sol's question, and it is the right one to ask before touching a repair:
 * can the RECONSTRUCTION preserve ordering MuPDF already got correct, rather than
 * inventing another repair to undo damage we caused ourselves? Prevention beats
 * repair, and the stage scores say there is prevention available — RAW is 58/273
 * verbatim where MODEL is 46/273.
 *
 * Four buckets, and each one implies a different piece of work:
 *
 *   OK          RAW right, MODEL right      nothing to do
 *   BROKEN-BY-US RAW right, MODEL wrong     fix the reconstruction. Free accuracy.
 *   REPAIRED    RAW wrong, MODEL right      an existing repair is earning its keep
 *   HARD        RAW wrong, MODEL wrong      only here can a NEW repair be justified
 *
 * A rule derived without this split would be aimed at the wrong stage.
 *
 * Usage: node experiments/synth/classify-lam.js [--show N]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import { modelFromPdf } from "../../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { release } from "../../src/extract/mupdf-lifetime.js";
import { requireSubjects } from "../lib-gate.js";
import { verifyFixture } from "./verify-fixture.js";

const DIR = path.resolve("out/synth");
const PDF = path.join(DIR, "lam-powerpoint.pdf");
const TRUTH = path.join(DIR, "lam-truth.json");
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 6);

for (const f of [PDF, TRUTH]) {
  if (!fs.existsSync(f)) { console.error(`missing ${f} — run build.js --lam first`); process.exit(2); }
}
// HARD PRECONDITION. A synthetic score is worthless if the pipeline was fed a
// different font from the one the case authored — the numbers stay plausible and
// describe nothing. 273 cases were once scored entirely in a substituted face.
const fixture = await verifyFixture({ quiet: true, tag: "lam" });
if (!fixture.ok) {
  console.error(`\n  FIXTURE INVALID: ${fixture.reason}`);
  console.error("  Refusing to produce an accuracy score.");
  console.error("  Run experiments/synth/verify-fixture.js for detail.\n");
  process.exit(2);
}

const truth = JSON.parse(fs.readFileSync(TRUTH, "utf8"));
requireSubjects(truth.length, "cases", "lam-truth.json is empty");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const strip = (s) => norm(s).replace(/\s/g, "");     // ordering question, not spacing

const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const rawOf = (i) => {
  const st = doc.loadPage(i).toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");
  try { return norm(st.asText().replace(/^case \d+ ?:.*$/gm, "")); } finally { release(st); }
};

const model = modelFromPdf(PDF);
for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);
const modelOf = (i) => norm((model.pages[i]?.objects ?? [])
  .filter((o) => o.type === "text").map((o) => o.text)
  .filter((s) => !/^case \d+:/.test(String(s).trim())).join(" "));

const buckets = { OK: [], "BROKEN-BY-US": [], REPAIRED: [], HARD: [] };

for (const t of truth) {
  const want = strip(t.text);
  // Compare WITHOUT spaces: this file is about character ORDER, and the space
  // rule is already measured elsewhere. Mixing the two questions would make both
  // unanswerable.
  const raw = strip(rawOf(t.slide - 1));
  const got = strip(modelOf(t.slide - 1));
  const rawOk = raw.includes(want), gotOk = got.includes(want);
  const key = rawOk && gotOk ? "OK" : rawOk && !gotOk ? "BROKEN-BY-US" : !rawOk && gotOk ? "REPAIRED" : "HARD";
  buckets[key].push({ ...t, raw, got, want });
}

console.log(`\nlam-alef classification — ${truth.length} authored cases, ordering only (spaces ignored)\n`);
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  ${k.padEnd(13)} ${String(v.length).padStart(4)}  ${((v.length / truth.length) * 100).toFixed(1)}%`);
}

// The negative controls must never be "repaired" into something else.
const negs = truth.filter((t) => t.meta?.expectRepair === false);
const negBad = negs.filter((t) => !strip(modelOf(t.slide - 1)).includes(strip(t.text)));
console.log(`\n  negative controls (a lam NOT followed by an alef): ${negs.length}, wrong: ${negBad.length}`);
for (const n of negBad.slice(0, 4)) console.log(`     ${n.name}: want ${JSON.stringify(n.text)} got ${JSON.stringify(modelOf(n.slide - 1))}`);

for (const k of ["BROKEN-BY-US", "HARD"]) {
  if (!buckets[k].length) continue;
  console.log(`\n${k} — ${buckets[k].length} case(s), first ${Math.min(SHOW, buckets[k].length)}:`);
  for (const c of buckets[k].slice(0, SHOW)) {
    console.log(`  ${c.name}`);
    console.log(`     want ${JSON.stringify(c.want)}`);
    console.log(`     raw  ${JSON.stringify(c.raw.slice(0, 60))}`);
    console.log(`     got  ${JSON.stringify(c.got.slice(0, 60))}`);
  }
}

// The headline: how much accuracy is sitting in evidence we were handed and threw away.
console.log(`\n  ${buckets["BROKEN-BY-US"].length} case(s) are recoverable by PREVENTION — MuPDF had them right.`);
console.log(`  ${buckets.HARD.length} case(s) would need a new repair; only these can justify one.\n`);
