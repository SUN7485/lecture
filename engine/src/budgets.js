/**
 * Performance and correctness budgets for the 118-page owner reference deck.
 *
 * These are measured ceilings, not aspirational targets. They come from the
 * actual corpus run that produced the 6.71MB / 7,586-object deck. Anything
 * above these numbers is a regression, not a tuning opportunity.
 */
export const BUDGETS = {
  /** Maximum pages in a single import. */
  maxPages: 200,

  /** Maximum objects on one page. */
  maxObjectsPerPage: 1200,

  /** Maximum nested groups inside one page. */
  maxNesting: 20,

  /** Maximum string length for any text run. */
  maxStringLength: 4000,

  /** Maximum queued export jobs. */
  maxExportJobs: 20,

  /** Maximum PDF upload size in bytes (256 MB). */
  maxPdfBytes: 256 * 1024 * 1024,

  /** Maximum checkpoint size in bytes (50 MB). */
  maxCheckpointBytes: 50 * 1024 * 1024,

  /** Maximum undo snapshots kept in memory. */
  maxUndoSnapshots: 60,

  /** Maximum time for import of the 118-page deck (ms). */
  importMs: 60_000,

  /** Maximum peak RAM during import of the 118-page deck (MB). */
  peakRamMb: 512,

  /** Maximum export stage time for the 118-page deck (ms). */
  exportMs: 300_000,

  /** Maximum acceptable missing ink percentage. */
  missingInkPct: 0.03,

  /** Minimum acceptable ink IoU for Flattened mode (when enabled). */
  flattenedInkIou: 0.97,
};

export function checkBudget(name, actual, limit) {
  if (actual > limit) {
    console.warn(`[budget] ${name}: ${actual} exceeds limit ${limit}`);
    return false;
  }
  return true;
}
