/**
 * Local app server.
 *
 * The browser is the VIEW. The normalized model is the document: it is built
 * here from the PDF, edited in the page, posted back, and written to PPTX by
 * the same writer the CLI uses. Nothing is re-derived from the DOM, so what the
 * editor shows and what the export contains cannot drift apart.
 */
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { PNG } from "pngjs";
import { modelFromPdf } from "./model/normalize.js";
import { powerPointAvailable } from "./render/powerpoint.js";
import { auditPage, summarizeCoverage } from "./model/coverage.js";
import { facesForFamilies, availableFaces } from "./fonts/webfonts.js";
import { cacheImage, imageFile, mimeForRef } from "./model/images.js";
import { applyFixes, DEFAULT_REPAIRS } from "../web/doctor.js";
import { release } from "./extract/mupdf-lifetime.js";
import { attachmentDisposition } from "./http/headers.js";
import { buildId, releaseIdentity } from "./build-id.js";
import { badOrigin, registerDocument, resolveDocument, ALLOWED_ROOTS } from "./server-trust.js";
import { BUDGETS, checkBudget } from "./budgets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
/** Modules the browser shares with the server, served by exact path only. */
const SHARED_MODULES = new Set(["/src/extract/bidi.js"]);
const OUT = path.join(ROOT, "out");
const UPLOADS = path.join(ROOT, ".cache", "uploads");
const EXPORT_JOB_FILES = path.join(ROOT, ".cache", "export-jobs");
const CHECKPOINTS = path.join(ROOT, ".cache", "checkpoints");
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_EXPORT_JOBS = 20;
const MAX_CHECKPOINT_BYTES = 50 * 1024 * 1024;

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".json": "application/json; charset=utf-8" };

const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function readBytes(req, maxBytes = MAX_PDF_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxBytes) {
      const err = new Error("PDF is larger than 256 MB");
      err.code = "PAYLOAD_TOO_LARGE";
      req.resume();
      reject(err);
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        const err = new Error("PDF is larger than 256 MB");
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
      } else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function uploadName(header) {
  let raw = String(header || "lecture.pdf");
  try { raw = decodeURIComponent(raw); } catch { /* keep the literal name */ }
  const safe = path.basename(raw)
    .replace(/[^\p{L}\p{N} ._()\-]/gu, "_")
    .replace(/\s+/g, " ")
    .trim() || "lecture.pdf";
  return safe.toLowerCase().endsWith(".pdf") ? safe : `${safe}.pdf`;
}

function publicError(err) {
  const message = String(err?.message || err || "");
  if (err?.code === "PAYLOAD_TOO_LARGE") return "That PDF is larger than the 256 MB limit.";
  if (/password|encrypted|authenticate/i.test(message)) {
    return "This PDF is password-protected. Save an unlocked copy, then choose it again.";
  }
  if (/wasm|mupdf|memory access|null function|fz_|pdf_run|shared paths/i.test(message)) {
    return "The importer failed while reading this PDF. Your source file was not changed. Restart the app and try once more; if it repeats, keep the PDF and report the failure so this importer can be fixed.";
  }
  return "The PDF could not be opened. It may be damaged or use a PDF feature the importer does not support yet. Your source file was not changed.";
}

/** Cache of opened documents so page images do not re-read the file each time. */
const docs = new Map();
const MAX_OPEN_DOCS = 3;
const openDoc = (p) => {
  if (!docs.has(p)) {
    while (docs.size >= MAX_OPEN_DOCS) {
      const oldest = docs.keys().next().value;
      release(docs.get(oldest));
      docs.delete(oldest);
    }
    docs.set(p, mupdf.Document.openDocument(fs.readFileSync(p), "application/pdf"));
  }
  return docs.get(p);
};

// PowerPoint is a single-instance COM server. Jobs are asynchronous to the UI
// but serialized here, otherwise two exports can attach to the same instance and
// corrupt each other's open/render/embed stages.
const exportJobs = new Map();
let exportQueue = Promise.resolve();

function publicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    detail: job.detail,
    queuePosition: job.queuePosition ?? 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result ?? null,
    error: job.error ?? null,
  };
}

function pruneExportJobs() {
  if (exportJobs.size < MAX_EXPORT_JOBS) return;
  for (const [id, job] of exportJobs) {
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") exportJobs.delete(id);
    if (exportJobs.size < MAX_EXPORT_JOBS) break;
  }
}

function computeQueuePosition() {
  let pos = 0;
  for (const [, job] of exportJobs) {
    if (job.status === "queued") pos++;
  }
  return pos;
}

function enqueueExport({ model, docId, name, delivery, overrides }) {
  pruneExportJobs();
  if (exportJobs.size >= MAX_EXPORT_JOBS) {
    const err = new Error("Export queue is full");
    err.code = "QUEUE_FULL";
    throw err;
  }
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    status: "queued",
    stage: "candidate",
    progress: 0,
    queuePosition: computeQueuePosition(),
    detail: "Waiting for the local PowerPoint worker",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  exportJobs.set(jobId, job);

  const base = String(name || "edited").replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/_+/g, "_");
  const fileName = `${base || "edited"}-${jobId.slice(0, 8)}.pptx`;
  const file = path.join(OUT, fileName);
  fs.mkdirSync(EXPORT_JOB_FILES, { recursive: true });
  const pdf = resolveDocument(docId);
  if (!pdf) {
    const err = new Error("Document not found");
    err.code = "DOC_NOT_FOUND";
    throw err;
  }
  const payloadFile = path.join(EXPORT_JOB_FILES, `${jobId}.json`);
  fs.writeFileSync(payloadFile, JSON.stringify({ model, pdf, file, delivery: delivery || "editable", overrides: overrides || {} }), "utf8");

  const run = () => new Promise((resolve) => {
    job.status = "running";
    job.queuePosition = 0;
    job.updatedAt = new Date().toISOString();
    const child = fork(path.join(ROOT, "src", "export-worker.js"), [payloadFile], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const finish = () => {
      settled = true;
      job.updatedAt = new Date().toISOString();
    };
    child.on("message", (message) => {
      if (message?.type === "stage") {
        Object.assign(job, message.update, { updatedAt: new Date().toISOString() });
      } else if (message?.type === "done") {
        job.status = "done";
        job.stage = "done";
        job.progress = 100;
        job.detail = "Export ready";
        job.result = { file, fileName, ...message.result };
        finish();
      } else if (message?.type === "failed") {
        job.status = "failed";
        job.stage = "failed";
        job.error = String(message.error || "Export worker failed").slice(0, 500);
        job.detail = "Export failed";
        finish();
      }
    });
    child.on("error", (err) => {
      job.status = "failed";
      job.stage = "failed";
      job.error = String(err?.message || err).slice(0, 500);
      job.detail = "Export worker failed to start";
      finish();
    });
    child.on("exit", (code) => {
      fs.rmSync(payloadFile, { force: true });
      if (!settled) {
        job.status = "failed";
        job.stage = "failed";
        job.error = `Export worker exited with code ${code}`;
        job.detail = "Export failed";
        finish();
      }
      resolve();
    });
  });
  exportQueue = exportQueue.then(run, run);
  return job;
}

/* ------------------------------------------------------------------ checkpoints */
fs.mkdirSync(CHECKPOINTS, { recursive: true });

function checkpointPath(docId, revision) {
  return path.join(CHECKPOINTS, `${docId}-${String(revision).padStart(6, "0")}.json`);
}

function latestCheckpoint(docId) {
  const files = fs.readdirSync(CHECKPOINTS)
    .filter((f) => f.startsWith(`${docId}-`) && f.endsWith(".json"))
    .sort();
  return files.length ? path.join(CHECKPOINTS, files[files.length - 1]) : null;
}

function saveCheckpoint(docId, payload) {
  const rev = (payload.revision ?? 0) + 1;
  const cp = {
    schemaVersion: 1,
    buildId: buildId(),
    sourceName: payload.sourceName,
    sourceHash: payload.sourceHash,
    revision: rev,
    timestamp: new Date().toISOString(),
    model: payload.model,
    deliveryOverrides: payload.deliveryOverrides ?? {},
  };
  const tmp = checkpointPath(docId, rev) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cp, null, 2), "utf8");
  fs.renameSync(tmp, checkpointPath(docId, rev));
  return cp;
}

function loadCheckpoint(docId, revision) {
  const p = revision ? checkpointPath(docId, revision) : latestCheckpoint(docId);
  if (!p || !fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listCheckpoints(docId) {
  return fs.readdirSync(CHECKPOINTS)
    .filter((f) => f.startsWith(`${docId}-`) && f.endsWith(".json"))
    .sort()
    .map((f) => {
      const p = path.join(CHECKPOINTS, f);
      const stat = fs.statSync(p);
      return { file: f, revision: Number(f.split("-")[1]?.replace(".json", "")), size: stat.size, mtime: stat.mtime.toISOString() };
    });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;

  if (badOrigin(req)) {
    return sendJson(res, 403, { error: "Requests must originate from this machine." });
  }

  try {
    // ---- static -------------------------------------------------------------
    if (req.method === "GET" && (route === "/" || route === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(WEB, "index.html")), MIME[".html"]);
    }
    if (req.method === "GET" && /^\/[\w.-]+\.(js|css)$/.test(route)) {
      const f = path.join(WEB, route.slice(1));
      if (!fs.existsSync(f)) return send(res, 404, "not found", "text/plain");
      return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)]);
    }
    // The doctor decides paragraph direction with the SAME function the
    // extractor used, by importing it, because the alternative is a fourth copy
    // of that rule drifting from the other three. An explicit allowlist, never a
    // path join: everything else under src/ stays unreachable.
    if (req.method === "GET" && SHARED_MODULES.has(route)) {
      return send(res, 200, fs.readFileSync(path.join(ROOT, route.slice(1))), MIME[".js"]);
    }

    // ---- receive a PDF selected by the browser -----------------------------
    if (req.method === "POST" && route === "/api/upload") {
      const bytes = await readBytes(req);
      if (!bytes.length || bytes.subarray(0, 1024).indexOf("%PDF-") < 0) {
        return sendJson(res, 400, { error: "That file is not a PDF." });
      }
      const name = uploadName(req.headers["x-file-name"]);
      const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      fs.mkdirSync(UPLOADS, { recursive: true });
      const pdf = path.join(UPLOADS, `${digest}-${name}`);
      if (!fs.existsSync(pdf)) fs.writeFileSync(pdf, bytes);
      const docId = registerDocument(pdf);
      return sendJson(res, 200, { docId, name, sizeKb: Math.round(bytes.length / 1024) });
    }

    // ---- list PDFs in an allowed root ---------------------------------------
    if (req.method === "GET" && route === "/api/browse") {
      const dir = url.searchParams.get("dir") || "";
      const realDir = path.resolve(dir);
      if (![...ALLOWED_ROOTS].some((r) => realDir === r || realDir.startsWith(r + path.sep))) {
        return sendJson(res, 200, { dir, files: [] });
      }
      if (!fs.existsSync(realDir)) return sendJson(res, 200, { dir, files: [] });
      const files = fs.readdirSync(realDir)
        .filter((f) => f.toLowerCase().endsWith(".pdf"))
        .map((f) => ({ name: f, path: path.join(realDir, f), sizeKb: Math.round(fs.statSync(path.join(realDir, f)).size / 1024) }));
      return sendJson(res, 200, { dir, files });
    }

    // ---- build the model from a PDF ----------------------------------------
    if (req.method === "POST" && route === "/api/open") {
      const { docId } = await readBody(req);
      const pdf = resolveDocument(docId);
      if (!pdf || !fs.existsSync(pdf)) return sendJson(res, 400, { error: "The selected PDF is no longer available. Choose it again." });
      const started = Date.now();
      const model = modelFromPdf(pdf);
      // Budgets are ceilings, not targets. They come from the 118-page reference
      // deck; anything above is a regression, not a tuning opportunity.
      if (!checkBudget("pages", model.pages.length, BUDGETS.maxPages)) {
        return sendJson(res, 413, { error: `This PDF has ${model.pages.length} pages, which exceeds the supported limit of ${BUDGETS.maxPages}.` });
      }
      const maxObjects = Math.max(...model.pages.map((p) => p.objects.length));
      if (!checkBudget("objectsPerPage", maxObjects, BUDGETS.maxObjectsPerPage)) {
        return sendJson(res, 413, { error: `One page has ${maxObjects} objects, which exceeds the supported limit of ${BUDGETS.maxObjectsPerPage}.` });
      }
      const importMs = Date.now() - started;
      if (!checkBudget("importMs", importMs, BUDGETS.importMs)) {
        console.warn(`[budget] import took ${importMs}ms, limit ${BUDGETS.importMs}ms`);
      }
      // The same repairs `convert` applies, applied HERE rather than at export,
      // so the user reads the corrected text and the doctor reports only what is
      // genuinely left. Doing it at export instead would mean the editor showed
      // one deck and produced another, and would hide the repair entirely.
      const repaired = DEFAULT_REPAIRS
        .map((rule) => ({ rule, applied: applyFixes(model, rule).applied }))
        .filter((r) => r.applied);
      const audits = model.pages.map((p, i) => auditPage(p, model.rawCounts[i]));
      // Whether this deck can be sent to anyone else is decided at export, not in
      // the model — embedding needs PowerPoint on this machine. The doctor is the
      // place the user finds that out, so tell the model before it runs.
      model._canEmbed = powerPointAvailable() != null;
      if (!model._canEmbed) model._canEmbedReason = "PowerPoint is not installed on this machine";
      // Ship the document's own font files with the model. The browser cannot
      // resolve these families by name - they are installed per-user, which
      // Chromium does not expose to pages, so every bold run was falling back to
      // Segoe UI. See src/fonts/webfonts.js for the measurement.
      const families = model.pages.flatMap((p) =>
        p.objects.flatMap((o) => o.runs?.map((r) => r.fontFamily) ?? []));
      const fonts = facesForFamilies(families).map((f) => ({
        family: f.family, weight: f.weight, italic: f.italic,
        url: `/fonts/${encodeURIComponent(f.fileName)}`,
      }));
      const sourceHash = crypto.createHash("sha256").update(fs.readFileSync(pdf)).digest("hex").slice(0, 16);
      return sendJson(res, 200, { model, coverage: summarizeCoverage(audits), fonts, repaired, elapsedMs: Date.now() - started, sourceHash });
    }

    // ---- source page as PNG, for side-by-side comparison --------------------
    if (req.method === "GET" && route === "/api/page-image") {
      const docId = url.searchParams.get("docId");
      const pdf = resolveDocument(docId);
      if (!pdf) return send(res, 404, "no such document", "text/plain");
      const index = Number(url.searchParams.get("page") ?? 0);
      const width = Math.min(2000, Number(url.searchParams.get("w") ?? 1000));
      const page = openDoc(pdf).loadPage(index);
      let pix = null;
      try {
        const [x0, , x1] = page.getBounds();
        const scale = width / (x1 - x0);
        pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        return send(res, 200, Buffer.from(pix.asPNG()), MIME[".png"]);
      } finally {
        release(pix, page);
      }
    }

    // ---- a user-selected crop from the immutable source PDF -----------------
    if (req.method === "POST" && route === "/api/source-crop") {
      const { docId, page: pageIndex, x, y, w, h } = await readBody(req);
      const pdf = resolveDocument(docId);
      if (!pdf || !fs.existsSync(pdf)) return sendJson(res, 404, { error: "The source PDF is no longer available." });
      const index = Number(pageIndex);
      const box = [x, y, w, h].map(Number);
      if (!Number.isInteger(index) || index < 0 || box.some((n) => !Number.isFinite(n))) {
        return sendJson(res, 400, { error: "The source selection is invalid." });
      }
      const [nx, ny, nw, nh] = box;
      if (nx < 0 || ny < 0 || nw <= 0 || nh <= 0 || nx + nw > 1.001 || ny + nh > 1.001) {
        return sendJson(res, 400, { error: "The source selection falls outside the PDF page." });
      }

      const page = openDoc(pdf).loadPage(index);
      let pix = null;
      try {
        const [x0, , x1] = page.getBounds();
        const scale = 1800 / (x1 - x0);
        pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        const rendered = PNG.sync.read(Buffer.from(pix.asPNG()));
        const left = Math.max(0, Math.floor(nx * rendered.width));
        const top = Math.max(0, Math.floor(ny * rendered.height));
        const right = Math.min(rendered.width, Math.ceil((nx + nw) * rendered.width));
        const bottom = Math.min(rendered.height, Math.ceil((ny + nh) * rendered.height));
        const crop = new PNG({ width: Math.max(1, right - left), height: Math.max(1, bottom - top) });
        for (let row = 0; row < crop.height; row++) {
          const from = ((top + row) * rendered.width + left) * 4;
          rendered.data.copy(crop.data, row * crop.width * 4, from, from + crop.width * 4);
        }
        const ref = cacheImage(PNG.sync.write(crop), "png");
        return sendJson(res, 200, { ref, pixels: { w: crop.width, h: crop.height } });
      } finally {
        release(pix, page);
      }
    }

    // ---- the pixels behind one image object ---------------------------------
    if (req.method === "GET" && route === "/api/object-image") {
      // `imageFile` validates the ref's SHAPE before building any path, so this
      // never joins request text onto the filesystem. Refs are content hashes,
      // which makes them immutable and safe to cache hard.
      const file = imageFile(url.searchParams.get("ref") || "");
      if (!file) return send(res, 404, "no such image", "text/plain");
      res.writeHead(200, {
        "content-type": mimeForRef(path.basename(file)),
        "cache-control": "public, max-age=86400, immutable",
      });
      return res.end(fs.readFileSync(file));
    }

    // ---- export the EDITED model as an asynchronous local job --------------
    if (req.method === "POST" && route === "/api/exports") {
      const { model, docId, name, delivery, overrides } = await readBody(req);
      if (!model?.pages?.length) return sendJson(res, 400, { error: "empty model" });
      try {
        const job = enqueueExport({ model, docId, name, delivery, overrides });
        return sendJson(res, 202, publicJob(job));
      } catch (e) {
        if (e.code === "QUEUE_FULL") return sendJson(res, 429, { error: "Export queue is full. Wait for the current export to finish.", code: "QUEUE_FULL" });
        if (e.code === "DOC_NOT_FOUND") return sendJson(res, 400, { error: "The source PDF is no longer available. Open it again before exporting." });
        throw e;
      }
    }

    if (req.method === "GET" && /^\/api\/exports\/[0-9a-f-]+$/i.test(route)) {
      const id = route.slice("/api/exports/".length);
      const job = exportJobs.get(id);
      return job ? sendJson(res, 200, publicJob(job)) : sendJson(res, 404, { error: "no such export job" });
    }

    // ---- download an exported deck ------------------------------------------
    if (req.method === "GET" && route === "/api/download") {
      // Basename only, and it must be a file we actually produced. Never join
      // request text onto a path — that is a directory traversal waiting to
      // happen, and this server browses the user's own disk.
      const want = path.basename(url.searchParams.get("name") || "");
      const file = path.join(OUT, want);
      if (!want.endsWith(".pptx") || !fs.existsSync(file)) {
        return send(res, 404, "no such export", "text/plain");
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "content-disposition": attachmentDisposition(want),
        "content-length": body.length,
        "cache-control": "no-store",
      });
      return res.end(body);
    }

    // ---- font files, for @font-face -----------------------------------------
    if (req.method === "GET" && route.startsWith("/fonts/")) {
      const want = decodeURIComponent(route.slice("/fonts/".length));
      // Only ever serve a file we ourselves enumerated. Never join request text
      // onto a filesystem path: that is a directory traversal waiting to happen.
      const face = availableFaces().find((f) => f.fileName === want);
      if (!face) return send(res, 404, "unknown font", "text/plain");
      res.writeHead(200, {
        "content-type": /\.otf$/i.test(face.fileName) ? "font/otf" : "font/ttf",
        "cache-control": "public, max-age=86400",
      });
      return res.end(fs.readFileSync(face.file));
    }

    // ---- retention / deletion -------------------------------------------------
    if (req.method === "DELETE" && route.startsWith("/api/documents/")) {
      const docId = route.slice("/api/documents/".length);
      const pdf = resolveDocument(docId);
      if (!pdf) return sendJson(res, 404, { error: "no such document" });
      try { fs.rmSync(pdf, { force: true }); } catch {}
      documentRegistry.delete(docId);
      return sendJson(res, 200, { deleted: docId });
    }
    if (req.method === "DELETE" && /^\/api\/exports\/[0-9a-f-]+$/i.test(route)) {
      const id = route.slice("/api/exports/".length);
      const job = exportJobs.get(id);
      if (!job) return sendJson(res, 404, { error: "no such export job" });
      job.status = "cancelled";
      job.stage = "cancelled";
      job.detail = "Export cancelled by user";
      exportJobs.delete(id);
      const file = path.join(OUT, path.basename(job.result?.file || ""));
      try { fs.rmSync(file, { force: true }); } catch {}
      return sendJson(res, 200, { cancelled: id });
    }

    // ---- checkpoints ---------------------------------------------------------
    if (req.method === "POST" && route === "/api/checkpoints") {
      const { docId, model, sourceName, sourceHash, deliveryOverrides, revision } = await readBody(req);
      if (!docId || !model?.pages?.length) return sendJson(res, 400, { error: "invalid checkpoint" });
      const cp = saveCheckpoint(docId, { model, sourceName, sourceHash, deliveryOverrides, revision });
      return sendJson(res, 200, { docId, revision: cp.revision, timestamp: cp.timestamp });
    }
    if (req.method === "GET" && route.startsWith("/api/checkpoints/")) {
      const parts = route.slice("/api/checkpoints/".length).split("/");
      const docId = parts[0];
      const revision = parts[1] ? Number(parts[1]) : null;
      if (!docId) return sendJson(res, 400, { error: "docId required" });
      if (revision) {
        const cp = loadCheckpoint(docId, revision);
        if (!cp) return sendJson(res, 404, { error: "no such checkpoint" });
        return sendJson(res, 200, cp);
      }
      return sendJson(res, 200, { docId, checkpoints: listCheckpoints(docId) });
    }
    if (req.method === "DELETE" && route.startsWith("/api/checkpoints/")) {
      const parts = route.slice("/api/checkpoints/".length).split("/");
      const docId = parts[0];
      const revision = parts[1] ? Number(parts[1]) : null;
      if (!docId) return sendJson(res, 400, { error: "docId required" });
      const p = revision ? checkpointPath(docId, revision) : latestCheckpoint(docId);
      if (!p || !fs.existsSync(p)) return sendJson(res, 404, { error: "no such checkpoint" });
      fs.rmSync(p, { force: true });
      return sendJson(res, 200, { deleted: path.basename(p) });
    }

    // ---- diagnostics / support bundle ----------------------------------------
    if (req.method === "GET" && route === "/api/diagnostics") {
      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip();
      zip.addFile("identity.json", Buffer.from(JSON.stringify(releaseIdentity(), null, 2), "utf8"));
      zip.addFile("package.json", Buffer.from(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"), "utf8"));
      zip.addFile("environment.txt", Buffer.from(
        `Node: ${process.version}\nPlatform: ${process.platform}\nArch: ${process.arch}\nCWD: ${ROOT}\nPort: ${PORT}\n`, "utf8"));
      const log = path.join(ROOT, ".cache", "studio.log");
      if (fs.existsSync(log)) zip.addFile("studio.log", fs.readFileSync(log));
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": attachmentDisposition(`diagnostics-${new Date().toISOString().slice(0, 10)}.zip`),
        "cache-control": "no-store",
      });
      return res.end(zip.toBuffer());
    }

    // ---- health / identity ---------------------------------------------------
    if (req.method === "GET" && route === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        identity: releaseIdentity(),
        powerpoint: powerPointAvailable() != null,
      });
    }

    return send(res, 404, "not found", "text/plain");
  } catch (err) {
    console.error(`[${req.method} ${route}]`, err?.stack || err);
    return sendJson(res, 500, { error: publicError(err) });
  }
});

const PORT = Number(process.env.PORT ?? 5178);
server.listen(PORT, "127.0.0.1", () => console.log(`Lecture Reconstruction Studio → http://localhost:${PORT}`));
