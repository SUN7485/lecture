/**
 * Lecture Studio — hosted HTTP surface.
 *
 * Every route the internet can reach is in the table below. That is the point
 * of this file existing separately from engine/src/server.js: the local studio
 * trusts the machine it runs on (it lists directories on disk and accepts a
 * 256 MB upload), and no flag on that file would make its trust model safe to
 * expose. Here the filesystem is not addressable at all.
 *
 *   GET  /                    the editor (static, runs entirely client-side)
 *   GET  /<asset>             web/ assets, containment-checked
 *   GET  /healthz /readyz     liveness / readiness
 *   GET  /source              AGPL-3.0 s13 source offer
 *   POST /api/convert         PDF bytes -> editable deck HTML + model handle
 *   POST /api/export/pptx     model handle -> editable .pptx (portable fonts)
 *   POST /api/export/pdf      deck HTML   -> .pdf (headless Chromium)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { CONFIG, assertConfig } from './config.js';
import { ModelStore } from './lib/store.js';
import { RateLimiter } from './lib/ratelimit.js';
import { WorkerPool } from './lib/pool.js';
import { renderPdf, closeBrowser } from './lib/render-pdf.js';
import {
  send, sendJson, sendBuffer, readBytes, readJson,
  clientIp, originAllowed, SECURITY_HEADERS
} from './lib/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon'
};

const store = new ModelStore({ ttlMs: CONFIG.modelTtlMs, maxBytes: CONFIG.modelStoreMaxBytes });
const generalLimit = new RateLimiter({ windowMs: CONFIG.rateWindowMs, max: CONFIG.rateMaxRequests });
const convertLimit = new RateLimiter({ windowMs: CONFIG.rateWindowMs, max: CONFIG.rateMaxConversions });
const exportLimit = new RateLimiter({ windowMs: CONFIG.rateWindowMs, max: CONFIG.rateMaxExports });

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

// ---- CPU work happens in workers, never on the request thread ---------------
// modelFromPdf and writePptx are synchronous. On the main thread they block the
// event loop for their whole duration, which on a multi-user service is a
// denial of service, not a latency note: measured /healthz 51ms idle -> 2847ms
// during ONE ordinary conversion, and 124s for a crafted export.
const pool = new WorkerPool({
  size: CONFIG.workers,
  queueLimit: 8,
  jobTimeoutMs: CONFIG.exportTimeoutMs
});

// ---- sessions ---------------------------------------------------------------
// An opaque, httpOnly cookie. It carries no identity and grants no privilege;
// it exists so one browser cannot fetch another browser's stored model.
const COOKIE = 'ls_sid';
function sessionOf(req, res) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map((s) => s.trim()).find((c) => c.startsWith(COOKIE + '='));
  const existing = found ? found.slice(COOKIE.length + 1) : null;
  if (existing && /^[a-f0-9-]{36}$/.test(existing)) return existing;
  const sid = crypto.randomUUID();
  const secure = CONFIG.trustProxy ? '; Secure' : '';
  res.setHeader('set-cookie', COOKIE + '=' + sid + '; Path=/; HttpOnly; SameSite=Strict' + secure + '; Max-Age=86400');
  return sid;
}

// ---- static -----------------------------------------------------------------
function serveStatic(res, urlPath, req_ifNoneMatch) {
  // Resolve first, then prove containment. Never trust that stripping ".." was
  // sufficient — encodings and symlinks both defeat that.
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(WEB, rel);
  if (full !== WEB && !full.startsWith(WEB + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendJson(res, 404, { error: 'Not found' });
  const type = MIME[path.extname(full).toLowerCase()];
  if (!type) return sendJson(res, 403, { error: 'Forbidden' });

  // `no-cache` means "revalidate before use", NOT "do not store": the browser
  // still caches, it just asks first and usually gets a 304. A plain max-age
  // here means every user runs stale JS for that long after a deploy, which is
  // a genuine outage you cannot see from the server.
  const stat = fs.statSync(full);
  const etag = 'W/"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';
  if (req_ifNoneMatch === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }
  send(res, 200, fs.readFileSync(full), type, { 'cache-control': 'no-cache', etag });
}

// ---- routes -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  let route = '/';
  try {
    const url = new URL(req.url, 'http://localhost');
    route = url.pathname;

    // Liveness answers before any limit: a rate-limited process must not look
    // dead to the orchestrator and get killed while it is merely busy.
    if (route === '/healthz') return sendJson(res, 200, { ok: true });
    if (route === '/readyz') {
      return pool.warmed
        ? sendJson(res, 200, { ready: true, store: store.stats(), pool: pool.stats() })
        : sendJson(res, 503, { ready: false });
    }

    // AGPL-3.0 s13. Bundling MuPDF and serving it over a network obliges us to
    // offer the source to every user; config refuses to boot without the URL.
    if (route === '/source') {
      res.writeHead(302, { location: CONFIG.sourceUrl });
      return res.end();
    }

    const ip = clientIp(req);
    const gate = generalLimit.take(ip);
    if (!gate.ok) {
      return sendJson(res, 429, { error: 'Too many requests. Slow down.' },
        { 'retry-after': String(gate.retryAfterSec) });
    }

    // Two documents, one origin. The landing page sells the job; /editor does
    // it. Both are served with no-store so a deploy is never masked by a cached
    // shell pointing at assets that have moved.
    const PAGE = { '/': 'landing.html', '/editor': 'index.html', '/index.html': 'index.html' };
    if (req.method === 'GET' && PAGE[route]) {
      sessionOf(req, res);
      return send(res, 200, fs.readFileSync(path.join(WEB, PAGE[route])), MIME['.html'],
        { 'cache-control': 'no-store' });
    }

    if (req.method === 'GET' && !route.startsWith('/api/')) {
      return serveStatic(res, route, req.headers['if-none-match']);
    }

    // ---- writes: CSRF gate -------------------------------------------------
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    if (!originAllowed(req)) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });

    const sid = sessionOf(req, res);

    // ---- POST /api/convert -------------------------------------------------
    if (route === '/api/convert') {
      const quota = convertLimit.take(ip);
      if (!quota.ok) {
        return sendJson(res, 429, { error: 'Conversion limit reached. Try again shortly.' },
          { 'retry-after': String(quota.retryAfterSec) });
      }
      const bytes = await readBytes(req, CONFIG.maxUploadBytes);
      // Magic number, not the filename: an extension is a claim, the header is
      // evidence. Handing mupdf an arbitrary blob is an unnecessary risk.
      if (bytes.length < 5 || bytes.subarray(0, 1024).indexOf('%PDF-') < 0) {
        return sendJson(res, 400, { error: 'That file is not a PDF.' });
      }

      const name = String(req.headers['x-file-name'] || 'lecture')
        .replace(/[^\w.\- ]/g, '_').replace(/\.pdf$/i, '').slice(0, 80) || 'lecture';

      const result = await pool.run('convert', {
        bytes,
        name,
        maxPages: CONFIG.maxPages,
        maxObjectsTotal: CONFIG.maxObjectsTotal
      });
      if (result.error) return sendJson(res, result.status || 413, { error: result.error });

      const modelId = store.put(result.model, sid);
      const objects = result.objects;
      log('info', 'convert', {
        ms: result.ms, pages: result.pages, objects, kb: Math.round(bytes.length / 1024)
      });
      return sendJson(res, 200, {
        modelId, name, html: result.html,
        stats: { pages: result.pages, objects, ms: result.ms }
      });
    }

    // ---- POST /api/export/pptx --------------------------------------------
    if (route === '/api/export/pptx' || route === '/api/export/pdf') {
      const eq = exportLimit.take(ip);
      if (!eq.ok) {
        return sendJson(res, 429, { error: 'Export limit reached. Try again shortly.' },
          { 'retry-after': String(eq.retryAfterSec) });
      }
    }

    if (route === '/api/export/pptx') {
      // Large enough for the canvas state of a long deck (~100 bytes/object).
      const body = await readJson(req, 8 * 1024 * 1024);
      const stored = store.get(String(body.modelId || ''), sid);
      if (!stored) {
        return sendJson(res, 410, { error: 'That document has expired. Import the PDF again to export.' });
      }

      // Bound the payload before touching it. Measured unbounded: 20k
      // synthesized objects took 8.9s and 60k took 124s — superlinear, and a
      // single request that occupies the service for two minutes is a denial
      // of service whoever sends it.
      const entries = Array.isArray(body.objects) ? body.objects : [];
      if (entries.length > CONFIG.maxEditEntries) {
        return sendJson(res, 413, {
          error: `That deck has ${entries.length} objects, above the ${CONFIG.maxEditEntries} limit.`
        });
      }

      // The store holds the RECONSTRUCTION; every export is reconstruction plus
      // the canvas as it stands now. The worker receives a structured clone by
      // virtue of postMessage, so the stored copy is never mutated.
      const { buffer, stats: editStats } = await pool.run('pptx', { model: stored, objects: entries });
      const buf = Buffer.from(buffer);

      log('info', 'export-pptx', { bytes: buf.length, edits: editStats });
      return sendBuffer(res, 200, buf,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        (body.name || 'lecture') + '.pptx');
    }

    // ---- POST /api/export/pdf ---------------------------------------------
    if (route === '/api/export/pdf') {
      const body = await readJson(req, CONFIG.maxUploadBytes);
      if (typeof body.html !== 'string' || !body.html.length) {
        return sendJson(res, 400, { error: 'No deck to export.' });
      }
      const buf = await renderPdf(body.html, { timeoutMs: CONFIG.exportTimeoutMs });
      log('info', 'export-pdf', { bytes: buf.length });
      return sendBuffer(res, 200, buf, 'application/pdf', (body.name || 'lecture') + '.pdf');
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    const code = err && err.code;
    if (code === 'TOO_LARGE') {
      return sendJson(res, 413, { error: 'File is larger than the ' + Math.round(CONFIG.maxUploadBytes / 1048576) + ' MB limit.' });
    }
    if (code === 'BAD_JSON') return sendJson(res, 400, { error: 'Malformed request.' });
    if (code === 'BUSY') return sendJson(res, 503, { error: 'Server is busy. Try again in a moment.' }, { 'retry-after': '10' });
    if (code === 'MODEL_TOO_LARGE') return sendJson(res, 413, { error: err.message });
    // Never return err.message for an unexpected fault: it can carry absolute
    // paths and internals. Log it; hand the user a reference instead.
    const ref = crypto.randomUUID().slice(0, 8);
    log('error', 'unhandled', { ref, route, err: String((err && err.stack) || err) });
    if (!res.headersSent) return sendJson(res, 500, { error: 'Something went wrong on our side.', ref });
    res.end();
  } finally {
    if (route.startsWith('/api/')) log('debug', 'req', { route, ms: Date.now() - started });
  }
});

server.requestTimeout = CONFIG.exportTimeoutMs + 30000;
server.headersTimeout = 30000;

const sweeper = setInterval(() => {
  store.sweep(); generalLimit.sweep(); convertLimit.sweep(); exportLimit.sweep();
}, 60000);
sweeper.unref();

function shutdown(signal) {
  log('info', 'shutdown', { signal });
  server.close(() => {
    Promise.allSettled([closeBrowser(), pool.close()]).finally(() => process.exit(0));
  });
  // Never hang a deploy on one stuck connection.
  setTimeout(() => process.exit(0), 15000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

assertConfig();
server.listen(CONFIG.port, CONFIG.host, () => {
  log('info', 'listening', { port: CONFIG.port, host: CONFIG.host, source: CONFIG.sourceUrl });
  log('info', 'pool-starting', { workers: CONFIG.workers });
});
