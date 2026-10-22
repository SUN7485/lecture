/**
 * NUMERIC_DAMAGE must not invent characters the source never drew.
 *
 * The rules in `web/doctor.js` REORDER a damaged expression, and the last one
 * rebuilt its output from a template — `"$4 $3 $2 = $1"` — which reads well and
 * silently added four spaces to a page that painted `16=16+0`. On Unit Five p74
 * those four blocks were the only text in the entire deck rendering more than
 * one em wider than its own box, and the CONSTANT +7.4pt across strings of
 * different lengths was the tell: shaping drift scales with the string, invented
 * whitespace does not.
 *
 * The corpus cannot see this in either direction — it writes its arithmetic with
 * spaces, so a spacing-preserving rule and a spacing-inventing one give the same
 * answer on all 28 decks. So the invariant is asserted directly instead.
 *
 * Usage: node experiments/verify-numeric-repair.js [--seed-regression]
 */
import { repairNumericDirection } from "../web/doctor.js";
import { requireSubjects } from "./lib-gate.js";

const SEED = process.argv.includes("--seed-regression");
/** With the seed, restore the template that invented spaces. */
const repair = SEED
  ? (s) => s.replace(/^(\d[\d.,]*)\s*=\s*(\d[\d.,]*)\s*([+−×÷])\s*(\d[\d.,]*)$/gu, "$4 $3 $2 = $1")
  : repairNumericDirection;

const CASES = [
  // --- the reordering still happens, and the spacing is the SOURCE's ---------
  ["16=16+0",      "0+16=16",      "tight in, tight out — the case that was wrong"],
  ["0=0+0",        "0+0=0",        "Unit Five p74"],
  ["8=8+0",        "0+8=8",        "Unit Five p74"],
  ["16=16+0",      "0+16=16",      "Unit Five p74"],
  ["95 = 55 + 40", "40 + 55 = 95", "spaced in, spaced out — the shape the rule was written for"],
  ["16 = 16 + 0",  "0 + 16 = 16",  "spaced, and unchanged by the fix"],

  // --- the other members of the table, which must not drift -----------------
  ["%90",          "90%",          "a percent sign behind its number"],
  ["× 4 4",        "4 × 4",        "an operator ahead of its operands"],

  // --- shapes the rule must NOT touch ---------------------------------------
  ["0+16=16",      "0+16=16",      "already correct"],
  ["16+0=16",      "16+0=16",      "A+B=C is not the reversed shape"],
  ["2X1+X2≤40",    "2X1+X2≤40",    "not an all-numeric equation"],
];

let checked = 0;
const bad = [];
for (const [input, want, why] of CASES) {
  checked++;
  const got = repair(input);
  if (got !== want) bad.push({ input, want, got, why });
}

// THE INVARIANT, stated as a property rather than as more examples: whatever the
// rules do to an expression, they may not change how much whitespace is in it.
for (const [input] of CASES) {
  checked++;
  const ws = (s) => (s.match(/\s/g) ?? []).length;
  const got = repair(input);
  if (ws(got) !== ws(input)) {
    bad.push({ input, want: `${ws(input)} whitespace character(s)`, got: `${ws(got)}`,
               why: "a reorder may not invent or delete whitespace" });
  }
}

requireSubjects(checked, "numeric repair cases", "CASES is empty.");

console.log(`\nNUMERIC DAMAGE REPAIR — ${checked} checks`);
for (const b of bad) {
  console.log(`  WRONG  ${JSON.stringify(b.input)}  want ${JSON.stringify(b.want)}, got ${JSON.stringify(b.got)}`);
  console.log(`         ${b.why}`);
}
console.log("=".repeat(70));
if (bad.length) {
  console.log(`  GATE FAIL: ${bad.length} of ${checked} checks wrong.`);
  process.exit(1);
}
console.log("  GATE PASS: every reorder keeps the source's own spacing.");
