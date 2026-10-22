import crypto from 'node:crypto';

/**
 * Short-lived server-side model store.
 *
 * A reconstructed model is kept ONLY so a later PPTX export can use the real
 * model — with its per-glyph provenance and bidi runs — instead of trying to
 * re-derive that from the HTML the browser edited. It is not a database and it
 * must never grow without bound, so it is capped on BOTH axes: age and bytes.
 *
 * Eviction is oldest-first on insert, which is correct here because entries are
 * write-once and read a handful of times within minutes.
 */
export class ModelStore {
  constructor({ ttlMs, maxBytes, maxEntries = 2000 }) {
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    // Two ceilings, because the byte figure is an estimate and the count is not.
    this.maxEntries = maxEntries;
    this.entries = new Map(); // id -> { model, bytes, expiresAt, owner }
    this.bytes = 0;
  }

  /**
   * Approximate heap footprint, in real bytes.
   *
   * The naive sum of field lengths under-counts actual heap by a MEASURED
   * 2.68x — JS object headers, string overhead, array slack and property maps
   * are most of what a model costs. That mattered: a real 21-page lecture
   * summed to 415KB but occupied 1113KB of heap, so a 512MB "cap" would have
   * admitted ~1263 documents holding 1.34GB — past the 1536MB heap ceiling the
   * container sets, before the 2GB container limit even trips. The process
   * would OOM under sustained load and take every in-flight document with it.
   *
   * A cap whose unit does not match the resource it protects is not a cap, so
   * the factor is applied HERE and the configured limit means real bytes.
   */
  static OVERHEAD_FACTOR = 3;

  static sizeOf(model) {
    let n = 0;
    for (const page of model.pages || []) {
      n += 512;
      for (const obj of page.objects || []) {
        n += 256 + (obj.text ? obj.text.length * 2 : 0);
        for (const run of obj.runs || []) n += 128 + (run.text?.length || 0) * 2;
      }
    }
    return n * ModelStore.OVERHEAD_FACTOR;
  }

  put(model, owner) {
    this.sweep();
    const bytes = ModelStore.sizeOf(model);
    if (bytes > this.maxBytes) {
      const err = new Error('This document is too large to hold for export.');
      err.code = 'MODEL_TOO_LARGE';
      throw err;
    }
    while ((this.bytes + bytes > this.maxBytes || this.entries.size >= this.maxEntries) && this.entries.size) {
      const oldest = this.entries.keys().next().value;
      this.drop(oldest);
    }
    const id = crypto.randomUUID();
    this.entries.set(id, { model, bytes, owner, expiresAt: Date.now() + this.ttlMs });
    this.bytes += bytes;
    return id;
  }

  /** Ownership is checked here, not at the call site — a store that can hand a
   *  model to the wrong session is the whole bug. */
  get(id, owner) {
    const e = this.entries.get(id);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { this.drop(id); return null; }
    if (e.owner !== owner) return null;
    return e.model;
  }

  drop(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.bytes -= e.bytes;
    this.entries.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, e] of this.entries) if (e.expiresAt <= now) this.drop(id);
  }

  stats() {
    return { count: this.entries.size, maxEntries: this.maxEntries, bytes: this.bytes, maxBytes: this.maxBytes };
  }
}
