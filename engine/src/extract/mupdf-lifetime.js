/**
 * Eager release of the objects a MuPDF device callback is handed.
 *
 * The bindings wrap every Path, Text, StrokeState and ColorSpace passed to a
 * callback in a fresh JS object that takes its own WASM reference and registers
 * a FinalizationRegistry entry to drop it later. Nothing frees those references
 * until the garbage collector gets round to them, so a page with a thousand
 * painted objects leaves a thousand live WASM allocations queued behind JS heap
 * pressure that does not reflect their real cost — and this project has watched
 * that end in
 *
 *   RuntimeError: memory access out of bounds
 *     at fz_drop_text
 *     at FinalizationRegistry.cleanupSome
 *
 * mid-conversion on an image-heavy deck, intermittently, depending only on when
 * GC happened to run.
 *
 * `destroy()` unregisters the finalizer entry BEFORE dropping, so an object
 * released here can never be dropped a second time from the registry. Releasing
 * every borrowed object at the end of its callback therefore does not merely
 * make that crash less likely: it removes the queue the crash comes out of.
 *
 * Safe for callback arguments whose bridge constructor first takes its own
 * reference (Path, Text, StrokeState and ColorSpace). MuPDF 1.28 has one notable
 * exception handled separately below: Shade is wrapped without `fz_keep_shade`.
 */
export function release(...objects) {
  for (const o of objects) {
    try { o?.destroy?.(); } catch { /* already gone is the outcome we wanted */ }
  }
}

/**
 * Forget a callback wrapper around a pointer that the JS bridge did NOT retain.
 *
 * Calling `destroy()` would drop the page's own reference; doing nothing lets
 * FinalizationRegistry make the same bad drop later. Unregistering and clearing
 * the wrapper leaves ownership exactly where it began: with MuPDF's page runner.
 */
export function detachBorrowed(...objects) {
  for (const o of objects) {
    if (!o) continue;
    try { o.constructor?._finalizer?.unregister?.(o); } catch { /* best effort */ }
    o.pointer = 0;
  }
}
