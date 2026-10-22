/**
 * Server trust boundary — loopback, origin, opaque handles, allowed roots.
 *
 * Extracted so it can be tested without starting the HTTP server.
 */
import * as path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const WEB = path.join(ROOT, "web");
const OUT = path.join(ROOT, "out");
const UPLOADS = path.join(ROOT, ".cache", "uploads");
const EXPORT_JOB_FILES = path.join(ROOT, ".cache", "export-jobs");

export const ALLOWED_ROOTS = new Set([ROOT, WEB, OUT, UPLOADS, EXPORT_JOB_FILES]);

export function badOrigin(req) {
  const host = String(req.headers.host || "");
  const origin = String(req.headers.origin || "");
  const isLocal = host.startsWith("127.0.0.1:") || host.startsWith("localhost:");
  const isSameOrigin = !origin || origin === `http://${host}` || origin === `https://${host}`;
  return !isLocal || !isSameOrigin;
}

const documentRegistry = new Map();
let documentCounter = 0;

export function registerDocument(realPath) {
  const id = `doc-${++documentCounter}`;
  documentRegistry.set(id, realPath);
  return id;
}

export function resolveDocument(id) {
  return documentRegistry.get(id) || null;
}
