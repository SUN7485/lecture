/**
 * One resolution pass over every proposal, so the output cannot depend on order.
 *
 * THE DEFECT THIS REPLACES. Three repairs each mutated the glyph stream in turn,
 * so every one of them read a different document: the second saw the first's
 * inserts, and several of their gates quietly relied on that. The result was that
 * the registration order decided the corpus score. Measured across the six
 * permutations:
 *
 *   before the shared budget   4 of 5 orders differed, by up to 8 blocks, and the
 *                              SHIPPED order was the worst of the six
 *   after the shared budget    3 of 5 orders differed, by exactly 1 block —
 *                              `توقف الاستراحة`, where two producers both put an
 *                              alef back and the shipped order printed `االستراحة`
 *   after this                 0 (`experiments/verify-repair-order.js`)
 *
 * HOW. Producers are pure: each reads the SAME unmutated stream and returns
 * proposals, so no producer can see another's work and none of them can be
 * starved by running late. Resolution then happens once, in an order decided by
 * the strength of the evidence rather than by who spoke first.
 *
 * The two rules, and what each one is for:
 *
 *   BUDGET    a proposal that INFERRED its character from a count must pay for it
 *             out of its own WORD's deficit, and each missing character can be
 *             spent once. This is what stops two producers repairing one hole.
 *             A proposal that reads a glyph the page actually PAINTED pays for
 *             itself and is not charged — see `funded` below.
 *   SLOT      one position, one insert. Two proposals within SLOT_TOL of the same
 *             place are the same repair described twice; the stronger one wins and
 *             the other is dropped rather than stacked on top of it.
 *
 * AND ONE RULE THAT IS NOT HERE. An occupancy test — "a zero-width insert may not
 * land where a real character already sits" — was written, measured and removed.
 * It is the stated mechanism behind `المدخل التشغيلي` -> `المدخل التشغلي`, where
 * an insert collapsed into its neighbour and DELETED a supplied character, so it
 * looks obviously right. It cost **5 delivered blocks**: `الاستراتيجية` came out
 * `الستراتيجية` on four decks, because a zero-width alef proposed at a lam's tail
 * beside a real alef is not a collapse at all — it is the ordinary lam-alef
 * decomposition, and it is geometrically IDENTICAL to the failure. KNOWN_ISSUES
 * says the same thing about the same two sites: "the two are geometrically
 * identical", and four discriminators gave the same answer for both.
 *
 * What actually prevents the deletion is the BUDGET. That repair fired because a
 * row-level deficit let it spend a character missing from another word; priced per
 * word, `التشغيلي` owes nothing and no proposal is made. The guard belongs where
 * the evidence is, not at the point of insertion — a second gate over the same
 * question only bought false rejections.
 *
 * Nothing here decides WHAT a character is or WHERE it goes. The producers own
 * that, from the document's own evidence; this file only decides which proposals
 * are affordable, unique and safe.
 */

/** Two proposals this close together are proposing the same position (pt). */
const SLOT_TOL = 0.6;

/**
 * Apply the proposals that survive, and return the new stream.
 *
 * @param {object[]} glyphs     the original structured-text glyphs
 * @param {object[]} proposals  from the producers, in any order
 * @param {object} budget       from `attributePage`
 * @returns {object[]} glyphs with accepted characters spliced in
 */
export function resolveProposals(glyphs, proposals, budget) {
  if (!proposals.length) return glyphs;

  // DETERMINISTIC ORDER, and it must not mention the producer's identity or its
  // position in the input. Rank first, then geometry, then the character itself:
  // every term is a property of the evidence, so permuting the producers cannot
  // reorder this list.
  const first = (p) => (Array.isArray(p.glyph) ? p.glyph[0] : p.glyph);
  const ordered = [...proposals].sort((a, b) =>
    a.rank - b.rank ||
    a.slotY - b.slotY ||
    a.slotX - b.slotX ||
    first(a).c.codePointAt(0) - first(b).c.codePointAt(0));

  /** Positions already filled this pass, as [y, x]. */
  const filled = [];
  const takenSlot = (p) => filled.some(([y, x]) =>
    Math.abs(y - p.slotY) < SLOT_TOL && Math.abs(x - p.slotX) < SLOT_TOL);

  const accepted = new Map();      // anchor glyph -> glyph to insert after it
  const rejected = [];

  for (const p of ordered) {
    if (accepted.has(p.anchor)) { rejected.push([p, "anchor already carries an insert"]); continue; }
    if (takenSlot(p)) { rejected.push([p, "slot filled by a stronger proposal"]); continue; }
    // Only a proposal that INFERRED its character from a count has to buy it out
    // of the word's deficit. One that reads a glyph the page actually painted pays
    // for itself, and must not be gated on arithmetic that is unavailable at its
    // site: subset fonts report the colliding ligature as U+FFFD, worth 1 where it
    // owes 2, so the word balances while a letter is visibly gone. Charging that
    // producer a deficit it cannot have cost 5 delivered blocks —
    // `الاستراتيجية` -> `الستراتيجية` on four decks.
    // A proposal may put back more than one character — a LIGATURE under a mark
    // owes two — and it must then be able to afford both. Spending one at a time
    // and stopping half way would leave the word holding a lam with no alef,
    // which is worse than the loss it was repairing, so the charge is all or
    // nothing.
    const cost = p.cost ?? 1;
    if (p.funded !== false && !budget.spend(p.dev, cost)) {
      rejected.push([p, "word cannot afford this proposal"]);
      continue;
    }

    filled.push([p.slotY, p.slotX]);
    accepted.set(p.anchor, Array.isArray(p.glyph) ? p.glyph : [p.glyph]);
    p.effects?.();
  }

  // The rejection list is attached on BOTH paths. It used to be attached only
  // when something was accepted, so a page where every proposal was refused
  // handed the diagnostic an empty list — and it printed "ACCEPTED" beside each
  // refusal, which is the most misleading output a debugging tool can produce.
  if (!accepted.size) {
    glyphs.rejectedProposals = rejected;
    return glyphs;
  }

  // ONE rebuild, after resolution. Splice, never re-sort: the stream's order
  // already encodes work earlier passes did, and rebuilding it with a naive sort
  // broke `الحالات` -> `الحاالت` and `Effective` -> `Efefctive` when the orphan
  // merge tried it (KNOWN_ISSUES). Only the new glyphs move.
  const out = [];
  for (const g of glyphs) {
    out.push(g);
    const add = accepted.get(g);
    if (add) out.push(...add);
  }
  out.rejectedProposals = rejected;
  return out;
}
