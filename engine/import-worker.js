/**
 * PDF -> deck HTML, off the Electron main process.
 *
 * WHY: `modelFromPdf` is synchronous and CPU-bound. On the main process it
 * froze the whole window for its duration (0.5-2.1s on 20-27 pages, and it
 * scales with page count — a 118-page lecture was a visible hang). One worker
 * is kept alive by src/main.js so MuPDF's WASM (~800ms) loads once.
 *
 * Protocol: { id, filePath, title } -> { id, content, stats } | { id, error }
 */
import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const url = (rel) => pathToFileURL(path.join(HERE, rel)).href;

const [normalize, toHtml] = await Promise.all([
  import(url('src/model/normalize.js')),
  import(url('model-to-html.js'))
]);

parentPort.on('message', ({ id, filePath, title }) => {
  try {
    const started = Date.now();
    const model = normalize.modelFromPdf(filePath);
    const content = toHtml.modelToDeckHtml(model, { title });
    parentPort.postMessage({
      id,
      content,
      stats: {
        pages: model.pages.length,
        objects: model.pages.reduce((n, p) => n + p.objects.length, 0),
        ms: Date.now() - started
      }
    });
  } catch (err) {
    parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
});

parentPort.postMessage({ ready: true });
