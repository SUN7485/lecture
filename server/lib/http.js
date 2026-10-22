import { CONFIG } from '../config.js';

export function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

export function sendJson(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
}

export function sendBuffer(res, status, buf, type, filename) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': buf.length,
    // `attachment` and a quoted basename: a filename is user-influenced text
    // and must never be able to inject a header or steer the browser into
    // rendering the response inline.
    'content-disposition': `attachment; filename="${String(filename).replace(/[^\w.\-]/g, '_')}"`
  });
  res.end(buf);
}

/** Read a request body with a HARD ceiling, destroying the socket if exceeded —
 *  checking content-length alone trusts the client about its own size. */
export function readBytes(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > maxBytes) {
      const e = new Error('Payload too large'); e.code = 'TOO_LARGE';
      req.destroy(); return reject(e);
    }
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        const e = new Error('Payload too large'); e.code = 'TOO_LARGE';
        req.destroy(); return reject(e);
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, maxBytes) {
  const buf = await readBytes(req, maxBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { const e = new Error('Invalid JSON body'); e.code = 'BAD_JSON'; throw e; }
}

export function clientIp(req) {
  if (CONFIG.trustProxy) {
    // Only the LAST hop is trustworthy, and only when we know a proxy set it.
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * CSRF defence for state-changing requests. This API is cookie-authenticated,
 * so a foreign page could otherwise make a browser spend this user's quota.
 * Same-origin (or an explicitly allowed origin) only; a missing Origin header
 * is refused for writes rather than waved through.
 */
export function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (CONFIG.allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch { return false; }
}

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  // SAMEORIGIN, not DENY: the landing page and the template gallery preview
  // decks in same-origin iframes, and DENY blanked every one of them. Another
  // origin still cannot frame us (frame-ancestors below says the same thing to
  // browsers that read CSP).
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  // The editor renders reconstructed decks in an iframe from a srcdoc/blob and
  // inlines its own styles, so 'unsafe-inline' for style is load-bearing.
  // img-src must allow data: because every reconstructed image IS a data URL.
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    // Google Fonts is the font library: theme presets and the fonts panel fetch
    // faces from it and embed them into the deck as data: URLs, and the panel
    // previews them with its stylesheet. 'self' alone made both fail silently.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    "frame-src 'self' blob: data:",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
};
