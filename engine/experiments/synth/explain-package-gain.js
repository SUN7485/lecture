/**
 * Why does PACKAGE score higher than DELIVERED?
 *
 * The stage scores show DELIVERED 92.39% and PACKAGE 94.12% on the same 273 cases —
 * the .pptx read back scores 1.73 points BETTER than the model it was written from.
 * That is either a harmless difference in how the two are flattened into a string,
 * or the writer is reordering text, and the two have opposite consequences. A gain
 * nobody can explain is not a gain; it is an unexamined stage.
 *
 * This prints the cases where PACKAGE succeeds and DELIVERED fails, with both
 * strings and the model object's own `text` beside the concatenation of its runs,
 * which is what the writer actually emits.
 *
 * Usage: node experiments/synth/explain-package-gain.js [--lam] [--show N]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import JSZip from "jszip";
import { modelFromPdf } from "../../src/model/normalize.js";
import { writePptx } from "../../src/pptx/write.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { requireSubjects } from "../lib-gate.js";
import { verifyFixture } from "./verify-fixture.js";

const TAG = process.argv.includes("--lam") ? "lam" : "synth";
const DIR = path.resolve("out/synth");
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 6);

const fixture = await verifyFixture({ quiet: true, tag: TAG });
if (!fixture.ok) { console.error(`\n  FIXTURE INVALID: ${fixture.reason}\n`); process.exit(2); }

const truth = JSON.parse(fs.readFileSync(path.join(DIR, `${TAG}-truth.json`), "utf8"));
requireSubjects(truth.length, "cases", "truth is empty");

const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const notLabel = (s) => !/^case \d+:/.test(String(s).trim());

const model = modelFromPdf(path.join(DIR, `${TAG}-powerpoint.pdf`));
for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

/** DELIVERED as the scorers read it: the model object's own `text` field. */
const deliveredOf = (i) => norm((model.pages[i]?.objects ?? [])
  .filter((o) => o.type === "text").map((o) => o.text).filter(notLabel).join(" "));

/** What the WRITER actually emits: the concatenation of the object's runs. */
const runsOf = (i) => norm((model.pages[i]?.objects ?? [])
  .filter((o) => o.type === "text").map((o) => (o.runs ?? []).map((r) => r.text).join(""))
  .filter(notLabel).join(" "));

const pptxPath = path.join(DIR, `_explain-${TAG}.pptx`);
await writePptx(model, pptxPath);
const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const packageOf = async (slide) => {
  const xml = await zip.file(`ppt/slides/slide${slide}.xml`)?.async("string") ?? "";
  return norm((xml.match(/<a:t>([\s\S]*?)<\/a:t>/g) ?? [])
    .map((x) => decode(x.replace(/<\/?a:t>/g, ""))).filter(notLabel).join(" "));
};

const rows = [];
for (const t of truth) {
  const want = norm(t.text);
  const d = deliveredOf(t.slide - 1);
  const r = runsOf(t.slide - 1);
  const p = await packageOf(t.slide);
  rows.push({ name: t.name, want, delivered: d, runs: r, pkg: p,
    dOk: d.includes(want), rOk: r.includes(want), pOk: p.includes(want) });
}

const gained = rows.filter((x) => x.pOk && !x.dOk);
const lost = rows.filter((x) => x.dOk && !x.pOk);
const runsExplain = gained.filter((x) => x.rOk).length;

console.log(`\nPACKAGE vs DELIVERED — ${rows.length} cases\n`);
console.log(`  DELIVERED verbatim (model .text)      ${rows.filter((x) => x.dOk).length}`);
console.log(`  RUNS      verbatim (what we emit)     ${rows.filter((x) => x.rOk).length}`);
console.log(`  PACKAGE   verbatim (read back)        ${rows.filter((x) => x.pOk).length}`);
console.log(`\n  gained by PACKAGE over DELIVERED: ${gained.length}`);
console.log(`     of those, already correct in the RUNS: ${runsExplain}`);
console.log(`     i.e. explained by o.text vs runs, NOT by the writer: ${runsExplain === gained.length ? "ALL" : `${runsExplain} of ${gained.length}`}`);
console.log(`  lost by PACKAGE: ${lost.length}`);

for (const g of gained.slice(0, SHOW)) {
  console.log(`\n  ${g.name}`);
  console.log(`     want      ${JSON.stringify(g.want)}`);
  console.log(`     delivered ${JSON.stringify(g.delivered)}`);
  console.log(`     runs      ${JSON.stringify(g.runs)}`);
  console.log(`     package   ${JSON.stringify(g.pkg)}`);
}
console.log("");
