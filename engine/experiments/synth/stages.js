/**
 * WHERE does accuracy get lost? Score the same truth at four points in the pipeline.
 *
 * `score.js` answers "how good is the output". It cannot say which stage broke it,
 * and on the first synthetic run that mattered enormously: PowerPoint's raw MuPDF
 * text looked closer to the truth than what the pipeline built from it, which is
 * the opposite of the Chrome case this project was designed around.
 *
 * A single end-to-end number hides that completely. Four numbers make a stage that
 * LOSES accuracy impossible to miss:
 *
 *   1 RAW          MuPDF structured text, exactly as the library returns it
 *   2 MODEL        after buildLines / withSpaces / blockRuns — our reconstruction
 *   3 DELIVERED    after DEFAULT_REPAIRS
 *   4 PACKAGE      read back out of the .pptx we actually write
 *
 * Any stage whose score is LOWER than the one before it is destroying evidence it
 * was handed, and that is a different kind of bug from "we never had the data".
 *
 * Usage: node experiments/synth/stages.js [dir]      (default out/synth)
 *        node experiments/synth/stages.js --corpus   (Chrome, against HTML truth)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as mupdf from "mupdf";
import JSZip from "jszip";
import { modelFromPdf } from "../../src/model/normalize.js";
import { writePptx } from "../../src/pptx/write.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { release } from "../../src/extract/mupdf-lifetime.js";
import { requireSubjects } from "../lib-gate.js";
import { verifyFixture } from "./verify-fixture.js";

const DIR = path.resolve(process.argv.find((a) => !a.startsWith("--") && a.endsWith("synth")) ?? "out/synth");
/** --lam scores the targeted lam-alef population instead of the broad set. */
const TAG = process.argv.includes("--bidi") ? "bidi" : process.argv.includes("--space") ? "space" : process.argv.includes("--lam") ? "lam" : "synth";
const PDF = path.join(DIR, `${TAG}-powerpoint.pdf`);
const TRUTH = path.join(DIR, `${TAG}-truth.json`);

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

function lcs(a, b) {
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Text of one model page, minus the scaffolding label. */
const pageText = (model, i) => norm((model.pages[i]?.objects ?? [])
  .filter((o) => o.type === "text")
  .map((o) => o.text)
  .filter((s) => !/^case \d+:/.test(String(s).trim()))
  .join(" "));

for (const f of [PDF, TRUTH]) {
  if (!fs.existsSync(f)) { console.error(`missing ${f} — run experiments/synth/build.js first`); process.exit(2); }
}
// HARD PRECONDITION. A synthetic score is worthless if the pipeline was fed a
// different font from the one the case authored — the numbers stay plausible and
// describe nothing. 273 cases were once scored entirely in a substituted face.
const fixture = await verifyFixture({ quiet: true });
if (!fixture.ok) {
  console.error(`\n  FIXTURE INVALID: ${fixture.reason}`);
  console.error("  Refusing to produce an accuracy score.");
  console.error("  Run experiments/synth/verify-fixture.js for detail.\n");
  process.exit(2);
}

const truth = JSON.parse(fs.readFileSync(TRUTH, "utf8"));
requireSubjects(truth.length, "cases", "truth.json is empty");

// ---- stage 1: raw structured text ------------------------------------------
const doc = mupdf.Document.openDocument(fs.readFileSync(PDF), "application/pdf");
const rawPages = [];
for (let i = 0; i < doc.countPages(); i++) {
  const page = doc.loadPage(i);
  // The SAME options the extractor asks for, so this measures what production is
  // handed and not a friendlier variant of it (EVO-033).
  const st = page.toStructuredText("preserve-whitespace,preserve-spans,inhibit-spaces");
  try { rawPages.push(norm(st.asText().replace(/^case \d+ ?:.*$/gm, ""))); }
  finally { release(st); }
}

// ---- stages 2 and 3 ---------------------------------------------------------
const model = modelFromPdf(PDF);
const modelPages = truth.map((t) => pageText(model, t.slide - 1));
const repaired = modelFromPdf(PDF);
for (const rule of DEFAULT_REPAIRS) applyFixes(repaired, rule);
const deliveredPages = truth.map((t) => pageText(repaired, t.slide - 1));

// ---- stage 4: out of the package -------------------------------------------
const pptxPath = path.join(DIR, "_stages.pptx");
await writePptx(repaired, pptxPath);
const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const packagePages = [];
for (const t of truth) {
  const name = `ppt/slides/slide${t.slide}.xml`;
  const xml = zip.file(name) ? await zip.file(name).async("string") : "";
  // RUNS INSIDE ONE PARAGRAPH CONCATENATE — PowerPoint renders no separator between
  // them. Joining every <a:t> with a space invents separators that are not there,
  // and it inflated this stage by 1.73 points: 28 cases where the model held
  // "68مجال" and the scorer read "68 مجال" and called it verbatim. Flatten each
  // paragraph first, then join the paragraphs.
  const paras = xml.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [];
  packagePages.push(norm(paras
    .map((p) => (p.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [])
      .map((x) => decode(x.replace(/<\/?a:t>/g, ""))).join(""))
    .filter((s) => !/^case \d+:/.test(s.trim()))
    .join(" ")));
}

// ---- score each stage against the same truth --------------------------------
const STAGES = [
  ["1 RAW        mupdf structured text", (i) => rawPages[truth[i].slide - 1] ?? ""],
  ["2 MODEL      our reconstruction   ", (i) => modelPages[i]],
  ["3 DELIVERED  after repairs        ", (i) => deliveredPages[i]],
  ["4 PACKAGE    read out of the pptx ", (i) => packagePages[i]],
];

console.log(`\nstage-by-stage, ${truth.length} authored cases, producer: PowerPoint\n`);
console.log("  stage                                verbatim      recall");

const scores = [];
for (const [label, get] of STAGES) {
  let v = 0, c = 0, want = 0;
  for (const [i, t] of truth.entries()) {
    const w = norm(t.text), got = get(i);
    if (got.includes(w)) v++;
    c += lcs(got, w);
    want += w.length;
  }
  const rec = (c / want) * 100;
  scores.push({ label, verbatim: v, recall: rec });
  console.log(`  ${label}   ${String(v).padStart(3)}/${truth.length}   ${rec.toFixed(2).padStart(7)}%`);
}

// A stage that scores lower than the one before it is destroying evidence it was
// handed. That is the finding this file exists to make loud.
console.log("");
let regressed = false;
for (let i = 1; i < scores.length; i++) {
  const d = scores[i].recall - scores[i - 1].recall;
  if (d < -0.5) {
    regressed = true;
    console.log(`  RECONSTRUCTION REGRESSION: ${scores[i].label.trim()} loses ${(-d).toFixed(2)} points of recall`);
    console.log(`     it was handed better evidence than it produced.`);
  }
}
if (!regressed) console.log("  no stage loses recall against the one before it.");
console.log("");
