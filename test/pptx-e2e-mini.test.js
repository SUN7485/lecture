'use strict';

// The fast end-to-end chain that lives in `npm test`.
//
// Everything else in the suite either mocks an adapter or tests one stage. This
// one drives the real button on a real 3-slide deck and checks BOTH halves of
// the promise: the deck is verified against PowerPoint's own render, and what
// landed in the file is genuinely native (real text, a real table, and a
// picture where the SVG was) rather than a page of screenshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const JSZip = require('jszip');
const { ROOT, launchLve } = require('./support/launch-electron');

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'mini-deck.html');
const FIDELITY_ROOT = path.join(ROOT, '.fidelity');
const POWERPOINT_PATHS = [
  'C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE'
];
const powerPointInstalled = process.platform === 'win32' && POWERPOINT_PATHS.some((p) => fs.existsSync(p));

const runDirs = () => (fs.existsSync(FIDELITY_ROOT)
  ? fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []);

test('mini deck exports natively and verifies end to end', { timeout: 8 * 60 * 1000 }, async () => {
  const outPath = path.join(FIDELITY_ROOT, 'mini-e2e.pptx');
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  fs.rmSync(outPath, { force: true });
  const before = new Set(runDirs());

  const { app, page } = await launchLve({ open: FIXTURE, exportPath: outPath });
  let report = null;
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length === 3, null, { timeout: 120000 });
    await page.click('#btn-export-pptx');
    await page.waitForFunction(() => /^تم التصدير|^PPTX export /
      .test(document.getElementById('status').textContent || ''), null, { timeout: 7 * 60 * 1000 });
    const status = await page.evaluate(() => document.getElementById('status').textContent);

    const created = runDirs().filter((dir) => !before.has(dir)).sort();
    const reportPath = created.length
      ? path.join(FIDELITY_ROOT, created[created.length - 1], 'fidelity-report.json') : null;
    assert.ok(reportPath && fs.existsSync(reportPath), `no fidelity report (status: ${status})`);
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.ok(fs.existsSync(outPath), `no pptx was written (status: ${status})`);
  } finally {
    await app.close().catch(() => {});
  }

  // --- half one: the deck is editable, not a slideshow of screenshots ---
  const zip = await JSZip.loadAsync(fs.readFileSync(outPath));
  const slideNames = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slideNames.length, 3, 'three slides must reach the package');

  const slideXml = await Promise.all(slideNames.sort().map((name) => zip.file(name).async('string')));
  const allXml = slideXml.join('');
  assert.match(allXml, /<a:t>/, 'the deck must carry native text runs');
  assert.ok(/<a:tbl>/.test(allXml), 'the table must be a native PowerPoint table');
  assert.ok(/<a:gradFill>/.test(allXml), 'the gradient cover must be a native gradient fill');
  assert.ok(/<p:pic>/.test(allXml), 'the inline SVG must land as a picture');
  assert.ok(Object.keys(zip.files).some((name) => /^ppt\/media\//.test(name)), 'the baked picture needs a media part');

  // --- half two: it was measured against PowerPoint's own render ---
  if (!powerPointInstalled) {
    console.error('\n*** SKIPPED the verification half: desktop PowerPoint is not installed here.');
    console.error(`*** evidenceMode=${report.evidenceMode} verificationState=${report.verificationState}\n`);
    assert.equal(report.verificationState, 'unverified',
      'without PowerPoint the export must still succeed, honestly marked unverified');
    return;
  }

  assert.equal(report.evidenceMode, 'full',
    'PowerPoint is installed, so the shipping path must run full evidence');
  assert.equal(report.verificationState, 'verified', `slide verdicts: ${JSON.stringify(report.slideVerdicts)}`);
  assert.equal(report.failedSlideCount, 0);
  assert.equal(report.verifiedSlideCount, 3);
  for (const verdict of report.slideVerdicts) {
    assert.equal(typeof verdict.ssim, 'number', `slide ${verdict.slide} has no SSIM`);
  }
  assert.equal(report.geometry?.ok, true, 'every shape must land where the browser measured it');
});
