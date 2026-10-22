/**
 * Fixed-window rate limiter, in memory.
 *
 * In memory is a deliberate scope choice, and it has one honest consequence:
 * limits are PER PROCESS, so they multiply if this is ever scaled to several
 * instances. That is fine for one VM and wrong for a fleet — moving to Redis is
 * the change to make at that point, not a bigger number here.
 */
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> { count, resetAt }
  }

  /** @returns {{ok: boolean, retryAfterSec: number, remaining: number}} */
  take(key, cost = 1) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    if (e.count + cost > this.max) {
      return { ok: false, retryAfterSec: Math.ceil((e.resetAt - now) / 1000), remaining: 0 };
    }
    e.count += cost;
    return { ok: true, retryAfterSec: 0, remaining: this.max - e.count };
  }

  /** Called on a timer; without this the map is an unbounded leak keyed by IP. */
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.hits) if (e.resetAt <= now) this.hits.delete(k);
  }
}
