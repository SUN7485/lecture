/**
 * Hosted configuration. Every limit is here, every one is env-overridable, and
 * every default is chosen for a PUBLIC service rather than for a local studio.
 *
 * The local studio (engine/src/server.js) trusts the machine it runs on: it
 * browses the user's disk and accepts a 256 MB upload. None of that is safe on
 * the internet, which is why the hosted surface is a SEPARATE entry point with
 * a deliberately smaller route table rather than the local one behind a flag —
 * you can read this directory and see everything the internet can reach.
 */
const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
  return n;
};

export const CONFIG = {
  port: int('PORT', 8080),
  host: process.env.HOST || '0.0.0.0',

  // A lecture in the real corpus is 200-600 KB. 25 MB is ~40x the largest
  // observed one and still small enough that a hostile upload cannot exhaust
  // memory before the length check fires.
  maxUploadBytes: int('MAX_UPLOAD_BYTES', 25 * 1024 * 1024),


  // Budgets. The local studio has had these since long before the hosted build
  // (engine/src/budgets.js: 200 pages) and the hosted path shipped without
  // them, so a single document could occupy the service without limit.
  // Page count is checked BEFORE extraction — a limit enforced after the work
  // is done protects nothing.
  maxPages: int('MAX_PAGES', 200),
  maxObjectsTotal: int('MAX_OBJECTS_TOTAL', 60_000),
  // Bounds the export payload. Measured unbounded: 60k synthesized objects
  // occupied the process for 124 seconds.
  maxEditEntries: int('MAX_EDIT_ENTRIES', 20_000),
  workers: int('WORKERS', 2),
  conversionTimeoutMs: int('CONVERSION_TIMEOUT_MS', 120_000),
  exportTimeoutMs: int('EXPORT_TIMEOUT_MS', 300_000),

  // Models are held server-side only so a later PPTX export can use the real
  // model instead of re-deriving it from HTML. Short TTL, hard byte ceiling.
  modelTtlMs: int('MODEL_TTL_MS', 30 * 60_000),
  modelStoreMaxBytes: int('MODEL_STORE_MAX_BYTES', 512 * 1024 * 1024),

  rateWindowMs: int('RATE_WINDOW_MS', 60_000),
  rateMaxRequests: int('RATE_MAX_REQUESTS', 60),
  rateMaxConversions: int('RATE_MAX_CONVERSIONS', 10),
  // Exports are bounded per request now, but still cost real worker time. The
  // general limit alone would let one client fill both workers continuously.
  rateMaxExports: int('RATE_MAX_EXPORTS', 20),

  // AGPL-3.0 section 13: users interacting with this over a network must be
  // offered the Corresponding Source. An empty value is a licence violation,
  // so the server refuses to start without it.
  sourceUrl: process.env.SOURCE_URL || '',

  // Comma-separated. Empty = same-origin only (no Origin header cross-check
  // beyond rejecting foreign origins outright).
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  trustProxy: process.env.TRUST_PROXY === '1',
  logLevel: process.env.LOG_LEVEL || 'info'
};

/** Fail fast and loudly rather than serving in an illegal or unsafe state. */
export function assertConfig() {
  const problems = [];
  if (!CONFIG.sourceUrl) {
    problems.push(
      'SOURCE_URL is required. This app bundles MuPDF (AGPL-3.0-or-later); ' +
      'serving it over a network obliges you to offer the complete source to ' +
      'every user. Set SOURCE_URL to the public repository URL.'
    );
  }
  if (CONFIG.maxUploadBytes > 100 * 1024 * 1024) {
    problems.push('MAX_UPLOAD_BYTES above 100MB is not safe for a public service.');
  }
  if (problems.length) {
    throw new Error('Refusing to start:\n  - ' + problems.join('\n  - '));
  }
}
