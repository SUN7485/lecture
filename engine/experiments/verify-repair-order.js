/**
 * GATE: the repaired text must not depend on the ORDER the repairs run in.
 *
 * Each repair in `ligatures.js` recomputes the same per-baseline deficit from the
 * stream it is handed, so whichever runs first spends it and the others starve.
 * Measured on this tree: the ligature producer moved from first to last is worth
 * +7 blocks (71 -> 78) at no cost. A pipeline where the registration order of
 * three independent repairs silently decides the corpus score has no defensible
 * answer to "why this order", and nothing stops the next repair from starving the
 * three that already ship.
 *
 * This runs every permutation and compares the FULL TEXT of every block, not the
 * verbatim verdicts: two orders can produce different text while moving no block
 * across the pass/fail line, and a verdict comparison calls that invariant.
 *
 * **It is RED on the tree that introduced it, and that is the point** — the gate
 * was written before the fix, watched to fail, and is the definition of done for
 * Phase 2 of docs/ATTRIBUTION_PLAN.md. A gate first seen green proves nothing
 * (EVO-019).
 *
 * Each permutation runs as a child process, reusing the shipping dump path
 * (`verbatim-set --text`) rather than re-walking the corpus in-process: six
 * corpus passes in one WASM heap is a memory question nobody needs to answer, and
 * spawning guarantees the gate measures the same code the corpus gates measure.
 *
 *   node experiments/verify-repair-order.js
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { repairOrder } from "../src/extract/glyphs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DUMP = path.join(HERE, "verbatim-set.js");
// Derived, never typed out: a producer added to `glyphs.js` and forgotten here
// would leave the gate asserting order-independence over a set that no longer
// exists, and `repairOrder` would throw on every permutation.
const REPAIRS = repairOrder();
const SHOW = Number((process.argv.includes("--show") && process.argv[process.argv.indexOf("--show") + 1]) || 8);

function permutations(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

/** key -> text for every block in the corpus, under one repair order. */
function dump(order) {
  const stdout = execFileSync(process.execPath, [DUMP, "--text"], {
    env: { ...process.env, REPAIR_ORDER: order.join(",") },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const map = new Map();
  let n = 0;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const i = line.indexOf("\t");
    // Prefixed with the line number because block geometry is not unique: one
    // pair of blocks in this corpus shares a baseline AND a right edge, and a
    // Map keyed on geometry alone silently drops one of them — a blind spot in
    // the very gate that exists to prove nothing changed.
    map.set(`${++n} ${line.slice(0, i)}`, line.slice(i + 1));
  }
  return map;
}

const orders = permutations(REPAIRS);
console.log(`${orders.length} permutations of ${REPAIRS.join(", ")}\n`);

const reference = orders[0];
const base = dump(reference);
console.log(`  reference  ${reference.join(",").padEnd(34)} ${base.size} blocks`);

let differing = 0;
const examples = [];

for (const order of orders.slice(1)) {
  const got = dump(order);
  const diffs = [];
  for (const [k, text] of base) {
    if (!got.has(k)) { diffs.push([k, text, "(block does not exist)"]); continue; }
    if (got.get(k) !== text) diffs.push([k, text, got.get(k)]);
  }
  for (const k of got.keys()) if (!base.has(k)) diffs.push([k, "(block does not exist)", got.get(k)]);

  if (diffs.length) {
    differing++;
    if (examples.length < SHOW) examples.push({ order, diffs });
  }
  console.log(`  ${diffs.length ? "DIFFERS" : "same   "}    ${order.join(",").padEnd(34)} ${diffs.length} block(s)`);
}

for (const e of examples) {
  console.log(`\n${e.order.join(",")} — ${e.diffs.length} differing block(s), first ${Math.min(3, e.diffs.length)}:`);
  for (const [k, a, b] of e.diffs.slice(0, 3)) {
    console.log(`  ${k}`);
    console.log(`    ${reference.join(",")}: ${a.slice(0, 96)}`);
    console.log(`    ${e.order.join(",")}: ${b.slice(0, 96)}`);
  }
}

console.log();
console.log(differing === 0
  ? "GATE PASS: repaired text is identical under every repair order."
  : `GATE FAIL: ${differing} of ${orders.length - 1} permutations produce different text.`);
process.exit(differing === 0 ? 0 : 1);
