'use strict';

// Importing a PDF must not freeze the app. Reconstruction is synchronous and
// CPU-bound; on the Electron main process it blocked every IPC call and the
// window for its whole duration (measured ~1.4s on the 21-page fixture, worse
// with page count). It now runs on a worker thread, so the main process keeps
// answering while a PDF converts. This samples main-process round trips
// throughout an import and fails if any one of them stalls.

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const LECTURE = path.join(ROOT, 'test', 'fixtures', 'lecture.pdf');
const MAX_STALL_MS = 400;

test('the main process keeps answering while a PDF imports', { timeout: 180000 }, async () => {
  const { app, page } = await launchLve({ extraEnv: { LVE_OPEN_PDF: LECTURE } });
  try {
    await page.waitForSelector('#btn-import-pdf', { timeout: 30000 });
    // Warm the IPC path so the first sample does not measure startup.
    for (let i = 0; i < 5; i++) await app.evaluate(() => 1);

    let done = false;
    let importError = null;
    const importing = (async () => {
      await page.click('#btn-import-pdf');
      await page.waitForFunction(() => !!window.__editor && !!window.__importedPdf, null, { timeout: 120000 });
    })().catch((e) => { importError = e; }).finally(() => { done = true; });

    const stalls = [];
    while (!done) {
      const t0 = Date.now();
      await app.evaluate(() => 1);   // executes on the Electron main process
      stalls.push(Date.now() - t0);
      await new Promise((r) => setTimeout(r, 15));
    }
    await importing;
    if (importError) throw importError;

    const slides = await page.evaluate(() => window.__editor.slides().length);
    const worst = Math.max(...stalls);
    console.log(`import: ${slides} slides · ${stalls.length} main-process samples · worst round trip ${worst}ms`);
    assert.equal(slides, 21, 'the PDF did not import');
    assert.ok(stalls.length >= 5, `too few samples (${stalls.length}) to say anything`);
    assert.ok(worst < MAX_STALL_MS, `the main process stalled for ${worst}ms during import`);
  } finally {
    await app.close();
  }
});
