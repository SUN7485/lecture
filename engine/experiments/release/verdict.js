/**
 * Release gate status, with a third answer that is the whole point.
 *
 * A gate has three honest outcomes, not two. MEASURED 2026-08-22: the
 * flattened leg failed to convert two decks, and because a deck that never
 * converted contributes no failures, G3, G4, G5 and G8 all printed PASS on
 * that run. A gate that reports PASS because its input never ran is worse
 * than no gate, because someone will ship on it.
 *
 * So a gate whose evidence is missing reports BLOCKED, and BLOCKED is not
 * green. This is the same three-state rule the PPTX forensics already use,
 * where `null` means "this document gives this gate nothing to judge".
 *
 * Five states total:
 *   PASS    — observed and good
 *   FAIL    — observed and wrong
 *   BLOCKED — cannot be judged because a dependency is missing
 *   N/A     — not applicable to this deck/mode (e.g. editability on a raster-only page)
 *   UNKNOWN — data missing for an unknown reason
 */
export const PASS = "PASS";
export const FAIL = "FAIL";
export const BLOCKED = "BLOCKED";
export const NA = "N/A";
export const UNKNOWN = "UNKNOWN";

/**
 * @param {{failures?: string[], blockedBy?: string[], na?: string[], unknown?: string[]}} evidence
 * @returns {"PASS"|"FAIL"|"BLOCKED"|"N/A"|"UNKNOWN"}
 */
export function gateStatus({ failures = [], blockedBy = [], na = [], unknown = [] } = {}) {
  if (failures.length > 0) return FAIL;
  if (na.length > 0) return NA;
  if (unknown.length > 0) return UNKNOWN;
  if (blockedBy.length > 0) return BLOCKED;
  return PASS;
}

/** Decks whose artifacts do not exist or are stale, so nothing downstream may judge them. */
export function blockedDecks(decks) {
  return decks.filter((d) => d.converted !== true || d.stale === true).map((d) => `${d.mode}/${d.id}`);
}

/** Green means every gate passed or is N/A. BLOCKED/UNKNOWN are not green. */
export function isGreen(gates) {
  if (gates.length === 0) return false;
  return gates.every((g) => g.status === PASS || g.status === NA);
}
