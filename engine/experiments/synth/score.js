/**
 * Score our converter against text we WROTE OURSELVES.
 *
 * This is the first extraction measurement in this project that does not depend on
 * the Chrome corpus. The truth is not extracted from anything — `cases.js` holds
 * the exact strings, `build.js` puts them in a deck, and a real producer exports
 * the PDF. Whatever comes back is either those strings or a defect.
 *
 * TWO SCORER FAULTS THIS FILE AVOIDS, both already paid for in KNOWN_ISSUES:
 *
 *  - a CONTAINMENT test with no minimum length counts a two-character fragment as
 *    a correct record, which flatters every number. Here the whole expected string
 *    must appear, and character recall is reported BESIDE the verbatim count
 *    rather than instead of it.
 *  - scoring the RAW extraction answers a question no user asks. The default
 *    repairs run first, so this measures what the deck actually delivers.
 *
 * Usage: node experiments/synth/score.js [dir]   (default out/synth)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { modelFromPdf } from "../../src/model/normalize.js";
import { applyFixes, DEFAULT_REPAIRS } from "../../web/doctor.js";
import { requireSubjects } from "../lib-gate.js";
import { verifyFixture } from "./verify-fixture.js";

const DIR = path.resolve(process.argv.slice(2).find((a) => !a.startsWith("--") && fs.existsSync(a)) ?? "out/synth");
/** --lam scores the targeted lam-alef population instead of the broad set. */
const TAG = process.argv.includes("--bidi") ? "bidi" : process.argv.includes("--space") ? "space" : process.argv.includes("--lam") ? "lam" : "synth";
const PDF = path.join(DIR, `${TAG}-powerpoint.pdf`);
const TRUTH = path.join(DIR, `${TAG}-truth.json`);
const SHOW_ALL = process.argv.includes("--all");

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
const model = modelFromPdf(PDF);
for (const rule of DEFAULT_REPAIRS) applyFixes(model, rule);

/** Collapse whitespace only. Nothing else is normalised: a changed character is a defect. */
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Longest common subsequence length — character recall without alignment assumptions. */
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

/** Where two strings first differ, for a legible failure line. */
function firstDiff(got, want) {
  const n = Math.min(got.length, want.length);
  let i = 0;
  while (i < n && got[i] === want[i]) i++;
  return { at: i, got: got.slice(Math.max(0, i - 12), i + 18), want: want.slice(Math.max(0, i - 12), i + 18) };
}

requireSubjects(truth.length, "cases", "truth.json is empty");
requireSubjects(model.pages.length, "PDF pages", `${PDF} converted to nothing`);

let verbatim = 0, chars = 0, charsWanted = 0;
const failures = [];

for (const t of truth) {
  const page = model.pages[t.slide - 1];
  const pageText = norm((page?.objects ?? [])
    .filter((o) => o.type === "text")
    // The grey "case N: name" label is scaffolding, not content under test.
    .map((o) => o.text)
    .filter((s) => !/^case \d+:/.test(String(s).trim()))
    .join(" "));

  const want = norm(t.text);
  const ok = pageText.includes(want);
  if (ok) verbatim++;
  else failures.push({ ...t, got: pageText, want });

  charsWanted += want.length;
  chars += lcs(pageText, want);
}

console.log(`\nsynthetic ground truth — producer: PowerPoint, ${truth.length} cases\n`);
console.log(`  verbatim cases   ${verbatim}/${truth.length}  ${((verbatim / truth.length) * 100).toFixed(1)}%`);
console.log(`  character recall ${chars}/${charsWanted}  ${((chars / charsWanted) * 100).toFixed(2)}%`);

if (failures.length) {
  console.log(`\n${failures.length} case(s) did not come back verbatim:\n`);
  for (const f of failures.slice(0, SHOW_ALL ? failures.length : 8)) {
    const d = firstDiff(f.got, f.want);
    const r = lcs(f.got, f.want) / f.want.length;
    console.log(`  ${f.name}  (slide ${f.slide}, recall ${(r * 100).toFixed(1)}%)`);
    console.log(`     want ${JSON.stringify(f.want)}`);
    console.log(`     got  ${JSON.stringify(f.got)}`);
    console.log(`     first divergence at ${d.at}: want ${JSON.stringify(d.want)} got ${JSON.stringify(d.got)}`);
  }
  if (!SHOW_ALL && failures.length > 8) console.log(`  … and ${failures.length - 8} more (--all)`);
}

console.log("");
process.exit(failures.length ? 1 : 0);
