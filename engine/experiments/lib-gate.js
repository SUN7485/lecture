/**
 * A passing gate with ZERO evaluated subjects is not evidence.
 *
 * WHY THIS EXISTS. `verify-run-edges.js` takes `.pptx` files. It was handed a
 * `.pdf`, which is a perfectly good argument — so the empty-argv guard at the top
 * did not fire — found no decks it could read, and printed:
 *
 *   0 decks · 0 runs · 0 misplaced edge separators
 *   GATE PASS: every edge separator sits in the run whose direction it needs.
 *
 * That output was then quoted in a report as proof the deck passed the gate. It is
 * the same fault `src/pptx/inspect.js` carried from the opposite side, where a gate
 * FAILED on zero subjects: both come from a verdict computed as `bad === 0` with
 * nothing asserting that anything was ever looked at.
 *
 * Guarding the ARGUMENT COUNT is not enough and is what these scripts already did.
 * The invariant has to be on the subjects actually EXAMINED, downstream of every
 * filter, extension check and skipped file.
 *
 * Exit code 2 — "could not run" — deliberately differs from 1, "ran and failed",
 * so a CI step or a caller can tell a real regression from a mis-invocation.
 */

/**
 * Assert that a gate actually examined something before it is allowed a verdict.
 *
 * @param {number} count  subjects examined, AFTER filtering — decks opened, runs
 *                        read, blocks compared. Never the argument count.
 * @param {string} noun   what those subjects are, for the message ("decks").
 * @param {string} [hint] what the caller most likely got wrong.
 */
export function requireSubjects(count, noun, hint = "") {
  if (count > 0) return;
  console.log("=".repeat(72));
  console.log(`  GATE DID NOT RUN — 0 ${noun} examined.`);
  console.log("  A pass over nothing is not evidence, so this is not a pass.");
  if (hint) console.log(`  ${hint}`);
  process.exit(2);
}
