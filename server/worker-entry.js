/**
 * CPU work, off the request thread.
 *
 * WHY: `modelFromPdf` and `writePptx` are synchronous and CPU-bound. Run on the
 * main thread they block Node's event loop for their whole duration, which on a
 * multi-user service is not a performance note — it is a denial of service.
 * Measured before this existed: `/healthz` went from 51ms to 2847ms during ONE
 * ordinary 21-page conversion, and a crafted export occupied the process for
 * 124 seconds. During that window every other user is frozen and the container
 * healthcheck itself starts failing, so the orchestrator restarts a server that
 * was merely busy.
 *
 * Each worker loads MuPDF's WASM once (~800ms) and is then reused, so that cost
 * is paid per worker rather than per request.
 */
import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { arCount } from './lib/ar.js';

const DAMAGED = 'الملف تالف أو ناقص (ربما لم يكتمل تنزيله)، فلم أجد فيه أي صفحة. نزّله من جديد ثم حاول.';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '..', 'engine');
const url = (rel) => pathToFileURL(path.join(ENGINE, rel)).href;

const [normalize, toHtml, write, refont, edits] = await Promise.all([
  import(url('src/model/normalize.js')),
  import(url('model-to-html.js')),
  import(url('src/pptx/write.js')),
  import(url('src/pptx/refont.js')),
  import(url('apply-edits.js'))
]);

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-w-'));
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const handlers = {
  /**
   * Page count is checked BEFORE the expensive extraction, not after. Checking
   * afterwards means the work an over-limit document costs has already been
   * spent — the limit protects nothing at that point.
   */
  async convert({ bytes, name, maxPages, maxObjectsTotal }) {
    return withTempDir(async (dir) => {
      const pdf = path.join(dir, 'in.pdf');
      fs.writeFileSync(pdf, Buffer.from(bytes));

      const mupdf = await import('mupdf');
      let probe;
      try {
        probe = mupdf.Document.openDocument(fs.readFileSync(pdf), 'application/pdf');
      } catch (_) {
        return { error: DAMAGED, code: 'PDF_DAMAGED', status: 422 };
      }
      // Encrypted with a user password: MuPDF can still count pages and paint
      // blank-ish images, which once imported as "21 scanned pages". Say what
      // it actually is and how to get a usable copy.
      if (probe.needsPassword && probe.needsPassword()) {
        return { error: 'الملف محمي بكلمة مرور، فلا يمكن قراءة محتواه. افتحه في قارئ PDF بكلمة المرور، واحفظ نسخة بلا حماية (اطبعه إلى PDF)، ثم استورد تلك النسخة.', code: 'PDF_ENCRYPTED', status: 422 };
      }
      const pages = probe.countPages();
      // A half-finished download opens and "repairs" to zero pages; reporting
      // that as a successful rebuild of nothing is worse than an error.
      if (!pages) return { error: DAMAGED, code: 'PDF_DAMAGED', status: 422 };
      if (pages > maxPages) {
        return {
          error: `الملف فيه ${arCount(pages, 'page')}، والحد الأقصى ${maxPages}. قسّمه إلى أجزاء أصغر واستورد كل جزء وحده.`,
          code: 'TOO_MANY_PAGES', pages, max: maxPages, status: 413
        };
      }

      const started = Date.now();
      const model = normalize.modelFromPdf(pdf);
      const objects = model.pages.reduce((n, p) => n + p.objects.length, 0);
      if (objects > maxObjectsTotal) {
        return { error: `الملف فيه ${arCount(objects, 'object')}، والحد الأقصى ${maxObjectsTotal}. قسّمه إلى أجزاء أصغر.`, code: 'TOO_MANY_OBJECTS', status: 413 };
      }
      const html = toHtml.modelToDeckHtml(model, { title: name });
      return { model, html, ms: Date.now() - started, pages: model.pages.length, objects };
    });
  },

  async pptx({ model, objects }) {
    const stats = Array.isArray(objects) && objects.length
      ? edits.applyDeckEdits(model, objects)
      : null;
    const buf = await withTempDir(async (dir) => {
      const raw = path.join(dir, 'deck.pptx');
      const out = path.join(dir, 'portable.pptx');
      await write.writePptx(model, raw);
      // Always the portable pass: a hosted export is by definition for a
      // machine we know nothing about.
      await refont.refontPptx(raw, out);
      return fs.readFileSync(out);
    });
    return { buffer: buf, stats };
  }
};

parentPort.on('message', async (msg) => {
  const { id, op, payload } = msg;
  try {
    const handler = handlers[op];
    if (!handler) throw new Error(`unknown op: ${op}`);
    const result = await handler(payload);
    // Transfer the PPTX bytes rather than copying them.
    const transfer = result.buffer ? [result.buffer.buffer] : [];
    parentPort.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});

parentPort.postMessage({ ready: true });
