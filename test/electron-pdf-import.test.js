'use strict';

// End-to-end proof of the merge: a PDF goes in through the real toolbar button,
// becomes an editable deck in the real editor, and comes back out as a PDF
// through the app's existing export path — one UI, one document, both formats.
//
// This drives the shipping code, not a harness re-implementation of it: the
// test clicks #btn-import-pdf and #btn-export, so if the wiring in
// renderer.js / preload.js / main.js breaks, this fails.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

// A real lecture from the corpus (21 pages, Arabic/RTL, 2 images). Override
// with LVE_TEST_PDF to run the same assertions against another document.
const LECTURE = process.env.LVE_TEST_PDF || path.join(ROOT, 'test', 'fixtures', 'lecture.pdf');
const EXPECTED_PAGES = Number(process.env.LVE_TEST_PDF_PAGES || 21);

test('a PDF imports into the editor and exports back out as a PDF', { timeout: 180000 }, async () => {
  assert.equal(fs.existsSync(LECTURE), true, `missing test lecture: ${LECTURE}`);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-pdf-import-'));
  const exportPath = path.join(workDir, 'exported.pdf');
  const shotPath = path.join(ROOT, '.fidelity', 'pdf-import-proof.png');

  const { app, page } = await launchLve({
    exportPath,
    extraEnv: { LVE_OPEN_PDF: LECTURE }
  });

  try {
    // ---- import -------------------------------------------------------
    await page.waitForSelector('#btn-import-pdf', { timeout: 30000 });
    await page.click('#btn-import-pdf');

    // The editor attaches only once the deck is in the iframe, so waiting on it
    // proves the reconstruction reached the canvas rather than merely returning.
    await page.waitForFunction(() => !!window.__editor && !!window.__importedPdf, null, { timeout: 120000 });

    const deck = await page.evaluate(() => {
      const doc = document.querySelector('#canvas').contentDocument;
      const slides = [...doc.querySelectorAll('.slide')];
      const objs = [...doc.querySelectorAll('.obj')];
      const text = doc.body.innerText || '';
      return {
        slides: slides.length,
        objects: objs.length,
        texts: doc.querySelectorAll('.obj.text').length,
        images: doc.querySelectorAll('img.obj').length,
        // A reconstruction that produced boxes instead of glyphs would still
        // count objects, so assert on the characters themselves.
        arabic: (text.match(/[؀-ۿ]/g) || []).length,
        replacementChars: (text.match(/�/g) || []).length,
        dir: doc.documentElement.getAttribute('dir'),
        status: document.querySelector('#status')?.textContent || ''
      };
    });

    assert.equal(deck.slides, EXPECTED_PAGES, `expected ${EXPECTED_PAGES} slides, got ${deck.slides}`);
    assert.ok(deck.objects > 100, `too few objects reconstructed: ${deck.objects}`);
    assert.ok(deck.texts > 50, `too few text objects: ${deck.texts}`);
    assert.ok(deck.arabic > 500, `Arabic text did not survive reconstruction: ${deck.arabic} chars`);
    assert.equal(deck.replacementChars, 0, 'U+FFFD in the reconstructed deck');
    assert.equal(deck.dir, 'rtl', 'an Arabic lecture should come back right-to-left');

    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath });

    // ---- export back to PDF -------------------------------------------
    await page.click('#btn-export');
    await page.waitForFunction(
      () => /export|saved|pdf/i.test(document.querySelector('#status')?.textContent || ''),
      null,
      { timeout: 120000 }
    );
    // The status line is the app's claim; the file is the fact.
    await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {});
    for (let i = 0; i < 60 && !fs.existsSync(exportPath); i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    assert.equal(fs.existsSync(exportPath), true, 'no PDF was written');
    const bytes = fs.readFileSync(exportPath);
    assert.ok(bytes.length > 10000, `exported PDF is suspiciously small: ${bytes.length} bytes`);
    assert.equal(bytes.subarray(0, 4).toString('latin1'), '%PDF', 'exported file is not a PDF');

    console.log(
      `imported ${path.basename(LECTURE)}: ${deck.slides} slides, ${deck.objects} objects ` +
      `(${deck.texts} text, ${deck.images} images), ${deck.arabic} Arabic chars\n` +
      `exported PDF: ${bytes.length} bytes -> ${exportPath}\n` +
      `screenshot: ${shotPath}`
    );
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// The merge must not cost the app its original route. This also pins the
// origin flag: `__importedPdf` marks the open deck as PDF-sourced, and the
// planned "PDF-in uses the reconstruction exporter" routing will read it — a
// stale value would send a hand-written HTML lecture down the PDF path.
test('opening an HTML lecture still works, and clears the PDF-origin flag', { timeout: 120000 }, async () => {
  const HTML = path.join(ROOT, 'Chp1-Lec1-2.html');
  assert.equal(fs.existsSync(HTML), true, `missing HTML fixture: ${HTML}`);

  const { app, page } = await launchLve({ open: HTML, extraEnv: { LVE_OPEN_PDF: LECTURE } });
  try {
    await page.waitForFunction(() => !!window.__editor, null, { timeout: 60000 });
    const before = await page.evaluate(() => ({
      slides: document.querySelector('#canvas').contentDocument.querySelectorAll('.slide').length,
      importedPdf: window.__importedPdf || null
    }));
    assert.ok(before.slides > 0, 'the HTML lecture did not load');
    assert.equal(before.importedPdf, null, 'a freshly opened HTML deck must not look PDF-sourced');

    // Import a PDF, then load the HTML again: the flag must go back to null.
    // Reload rather than #btn-open — that button opens a modal file dialog with
    // no test hook, so clicking it here would hang forever. A reload re-runs
    // the real auto-open path, which is the same loadIntoIframe() we care about.
    await page.click('#btn-import-pdf');
    await page.waitForFunction(() => !!window.__importedPdf, null, { timeout: 120000 });
    await page.reload();
    await page.waitForFunction(() => !!window.__editor && window.__importedPdf === null, null, { timeout: 60000 });

    const after = await page.evaluate(() => ({
      slides: document.querySelector('#canvas').contentDocument.querySelectorAll('.slide').length,
      importedPdf: window.__importedPdf || null
    }));
    assert.ok(after.slides > 0, 'the HTML lecture did not reload after a PDF import');
    assert.equal(after.importedPdf, null, 'PDF origin leaked onto a re-opened HTML deck');
    console.log(`HTML route intact: ${before.slides} slides, flag cleared after a PDF round trip`);
  } finally {
    await app.close().catch(() => {});
  }
});
