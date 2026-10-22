/**
 * GATE for a doctor auto-fix, measured where it actually runs.
 *
 * The probes in this folder measure rewrites on BLOCK text. A shipped fix runs
 * per RUN inside `applyFixes`, over a model, after every other repair — a
 * different vantage point, and this project has already shipped one detector
 * that was perfect from the probe's seat and broke 1711 blocks from the repair's
 * (KNOWN_ISSUES, repairSkippedGlyphs). So this measures the real thing: build
 * the model, run the doctor's own fix, score the objects against ground truth.
 *
 * Measured this way, the tanween repair scores 73 where its probe said 91. That
 * gap is the reason this file exists.
 *
 * Usage: node experiments/verify-repair.js [ruleId ...] [--show]
 *        with no ruleId, every rule in DEFAULT_REPAIRS is verified together.
 */
import { modelFromPdf } from "../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { loadSlides, normalize } from "../src/truth/html-slides.js";
import { findPairs, alignPagesToSlides } from "../src/truth/corpus.js";
import { requireSubjects } from "./lib-gate.js";

const SHOW = process.argv.includes("--show");
const RULES = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const APPLY = RULES.length ? RULES : DEFAULT_REPAIRS;

let fixed = 0, broken = 0, stillWrong = 0, untouched = 0, changed = 0, pairsRead = 0;
const regressions = [], remaining = [];

for (const pair of findPairs()) {
  const model = modelFromPdf(pair.pdf);
  pairsRead++;
  const slides = loadSlides(pair.html);

  const pageTexts = model.pages.map((p) =>
    normalize(p.objects.filter((o) => o.type === "text").map((o) => o.text).join(" ")));
  const slideText = slides.map((s) => normalize(s.replace(/\n/g, " ")));
  const align = alignPagesToSlides(pageTexts, slideText);

  // Snapshot before, keyed by object id so identity survives the rewrite.
  const before = new Map();
  for (const p of model.pages) for (const o of p.objects) {
    if (o.type === "text" && o.text) before.set(o.id, o.text);
  }

  for (const rule of APPLY) applyFixes(model, rule);

  for (const [i, p] of model.pages.entries()) {
    if (align[i] < 0) continue;
    const truth = slideText[align[i]];
    for (const o of p.objects) {
      if (o.type !== "text" || !o.text) continue;
      const was = before.get(o.id);
      if (was === undefined) continue;
      if (was === o.text) { untouched++; continue; }
      changed++;
      const wasOk = truth.includes(normalize(was));
      const isOk = truth.includes(normalize(o.text));
      if (!wasOk && isOk) fixed++;
      else if (wasOk && !isOk) { broken++; regressions.push(`${pair.name} p${i + 1}\n    was ${was}\n    now ${o.text}`); }
      else {
        stillWrong++;
        if (SHOW && remaining.length < 20) remaining.push(`${pair.name} p${i + 1}  ${o.text.slice(0, 70)}`);
      }
    }
  }
}

console.log(`repairs applied                   : ${APPLY.join(", ")}`);
console.log(`text objects rewritten by the fix : ${changed}`);
console.log(`  FIXED    (miss -> verbatim)     : ${fixed}`);
console.log(`  BROKEN   (verbatim -> miss)     : ${broken}`);
console.log(`  still wrong after the rewrite   : ${stillWrong}`);
console.log(`untouched objects                 : ${untouched}`);
if (regressions.length) {
  console.log("\nREGRESSIONS — these were correct and are not any more:");
  for (const r of regressions.slice(0, 20)) console.log(`  ${r}`);
}
if (SHOW && remaining.length) {
  console.log("\nrewritten but still not verbatim:");
  for (const r of remaining) console.log(`  ${r}`);
}
console.log(`\nnet ${fixed - broken >= 0 ? "+" : ""}${fixed - broken} blocks`);
// findPairs() returns [] when the corpus root is missing, and every counter
// here is then 0 — which used to print GATE PASS over nothing at all.
requireSubjects(pairsRead, "PDF/HTML pairs", "the corpus root in src/truth/corpus.js may be wrong.");
console.log(broken === 0 ? "GATE PASS: no block regressed." : "GATE FAIL: see regressions above.");
process.exit(broken === 0 ? 0 : 1);
