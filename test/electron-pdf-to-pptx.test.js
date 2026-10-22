'use strict';

// The second half of "export anywhere": a deck that ARRIVED as a PDF must also
// leave as an editable PPTX, through the app's existing verified export path.
//
// Kept separate from electron-pdf-import.test.js because this one is slow and
// environment-dependent: the export renders the deck twice (Chromium and real
// desktop PowerPoint) and compares every slide.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const LECTURE = process.env.LVE_TEST_PDF || path.join(ROOT, 'test', 'fixtures', 'lecture.pdf');

test('a PDF-imported deck exports as PPTX', { timeout: 600000 }, async () => {
  assert.equal(fs.existsSync(LECTURE), true, `missing test lecture: ${LECTURE}`);

  // The destination MUST live on the same volume as the app's own work dir.
  // The export commits by renaming its verified candidate into place, and
  // fs.rename across drives throws EXDEV on Windows — so a destination under
  // os.tmpdir() (C:) fails at the very last step after minutes of real work,
  // with a fully built and verified PPTX sitting in .fidelity/. Measured.
  const workDir = fs.mkdtempSync(path.join(ROOT, '.fidelity', 'pdf-pptx-test-'));
  const exportPath = path.join(workDir, 'exported.pptx');

  const { app, page } = await launchLve({
    exportPath,
    extraEnv: { LVE_OPEN_PDF: LECTURE }
  });

  try {
    await page.waitForSelector('#btn-import-pdf', { timeout: 30000 });
    await page.click('#btn-import-pdf');
    await page.waitForFunction(() => !!window.__editor && !!window.__importedPdf, null, { timeout: 120000 });

    const slides = await page.evaluate(
      () => document.querySelector('#canvas').contentDocument.querySelectorAll('.slide').length
    );
    assert.ok(slides > 0, 'nothing imported');

    await page.click('#btn-export-pptx');

    // Poll for the artifact rather than trusting the status line: the export
    // reports its own stages, and a stage message is not a file.
    let waited = 0;
    while (!fs.existsSync(exportPath) && waited < 480) {
      await new Promise((r) => setTimeout(r, 2000));
      waited += 2;
    }

    const status = await page.evaluate(() => document.querySelector('#status')?.textContent || '');

    assert.equal(fs.existsSync(exportPath), true, `no PPTX written after ${waited}s. status: ${status}`);
    const bytes = fs.readFileSync(exportPath);
    // A .pptx is a zip: it must start with the local file header magic.
    assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'exported file is not a zip/pptx');
    assert.ok(bytes.length > 20000, `exported PPTX suspiciously small: ${bytes.length} bytes`);

    // What matters is that the deck is real and EDITABLE — native text runs
    // with the right direction — not that it clears the frozen SSIM bar. That
    // bar (0.8487) is calibrated on sparse Arial and dense Arabic lands
    // 0.72-0.85 against it by construction; widening it is exactly what this
    // project refuses to do, so this test must not depend on it either.
    const AdmZip = require('adm-zip');
    const entries = new AdmZip(exportPath).getEntries().map((e) => e.entryName);
    const slideParts = entries.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    assert.equal(slideParts.length, slides, `PPTX has ${slideParts.length} slides, deck had ${slides}`);

    const slide1 = new AdmZip(exportPath).readAsText('ppt/slides/slide1.xml');
    const runs = (slide1.match(/<a:t>/g) || []).length;
    const rtl = (slide1.match(/rtl="1"/g) || []).length;
    const arabic = (slide1.match(/[؀-ۿ]/g) || []).length;
    assert.ok(runs > 0, 'slide 1 has no native text runs — it was flattened to a picture');
    assert.ok(arabic > 0, 'slide 1 carries no Arabic');
    assert.ok(rtl > 0, 'Arabic paragraphs were not marked right-to-left');

    console.log(
      `imported ${path.basename(LECTURE)} (${slides} slides) -> PPTX ${bytes.length} bytes in ~${waited}s\n` +
      `  ${slideParts.length} slide parts, ${entries.filter((n) => n.startsWith('ppt/media/')).length} media parts\n` +
      `  slide 1: ${runs} text runs, ${rtl} rtl paragraphs, ${arabic} Arabic chars\n` +
      `status: ${status}`
    );
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
