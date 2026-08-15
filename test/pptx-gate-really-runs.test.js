'use strict';

// THE TRIPWIRE (mission 034, EVO-019).
//
// The SSIM/pixel comparison existed for weeks while being unreachable: main.js
// hardcoded evidenceMode 'native' and every compare stage required 'full', so
// "verified export" was fiction and nothing failed. Unit tests with mocked
// adapters stayed green throughout — that is exactly why this test uses NO
// mocks and NO env overrides. It drives the real button, through the real IPC
// handler, and asserts that real numbers came back.
//
// If someone unplugs full evidence from the shipping path again, this fails.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'gate-deck.html');
const SHIFTED_HEADING_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'gate-shifted-heading-deck.html');
const FIDELITY_ROOT = path.join(ROOT, '.fidelity');

const runDirs = () => (fs.existsSync(FIDELITY_ROOT)
  ? fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []);

// Whether PowerPoint exists is decided HERE, from the filesystem — never from
// the report under test. Keying the skip off the report's own evidenceMode
// would let "someone unplugged the gate" masquerade as "no Office installed",
// which is the precise way the previous gate stayed fictional.
const POWERPOINT_PATHS = [
  'C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE'
];
const powerPointInstalled = process.platform === 'win32' && POWERPOINT_PATHS.some((p) => fs.existsSync(p));

async function exportThroughTheRealPath(deck, outName) {
  const outPath = path.join(FIDELITY_ROOT, outName);
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  fs.rmSync(outPath, { force: true });
  const before = new Set(runDirs());
  // LVE_EXPORT_PATH only skips the save dialog. Evidence mode is deliberately
  // NOT set: the shipping code must choose it.
  // Cache is disabled only because this tripwire must prove a fresh
  // browser-to-Office evidence pass every time; evidence mode remains owned by
  // the shipping code.
  const { app, page } = await launchLve({ open: deck, exportPath: outPath, extraEnv: { LVE_NO_CACHE: '1' } });
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length > 0, null, { timeout: 120000 });
    await page.click('#btn-export-pptx');
    await page.waitForFunction(() => /^تم التصدير|^PPTX export /
      .test(document.getElementById('status').textContent || ''), null, { timeout: 15 * 60 * 1000 });
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    const created = runDirs().filter((dir) => !before.has(dir)).sort();
    const workDir = created.length ? path.join(FIDELITY_ROOT, created[created.length - 1]) : null;
    const reportPath = workDir && path.join(workDir, 'fidelity-report.json');
    const report = reportPath && fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
    return { status, report, outPath };
  } finally {
    await app.close().catch(() => {});
  }
}

test('the shipping export path really runs the fidelity gate', { timeout: 20 * 60 * 1000 }, async () => {
  const { status, report } = await exportThroughTheRealPath(FIXTURE, 'gate-verified.pptx');
  assert.ok(report, `no fidelity report was produced (status: ${status})`);

  if (!powerPointInstalled) {
    // Loud, not silent: this machine genuinely cannot run the gate.
    console.error('\n*** SKIPPED: desktop PowerPoint is not installed on this machine.');
    console.error(`*** evidenceMode=${report.evidenceMode} verificationState=${report.verificationState}`);
    console.error('*** This test only proves anything where PowerPoint is installed.\n');
    assert.equal(report.verificationState, 'unverified',
      'without PowerPoint the export must still succeed, honestly marked unverified');
    return;
  }

  // PowerPoint IS installed, so the shipping path has no excuse: if this fails,
  // full evidence has been unplugged from the export again.
  assert.equal(report.evidenceMode, 'full',
    'PowerPoint is installed, so the shipping export path must run full evidence');

  assert.equal(report.verificationState, 'verified', `status was: ${status}`);
  assert.equal(report.failedSlideCount, 0);
  assert.ok(report.verifiedSlideCount >= 1);

  // The metrics must EXIST — a gate that reports no numbers is not a gate.
  for (const verdict of report.slideVerdicts) {
    assert.equal(verdict.verdict, 'verified');
    assert.equal(typeof verdict.ssim, 'number', 'every verified slide carries a real SSIM');
    assert.equal(typeof verdict.mismatchPercent, 'number');
    assert.ok(verdict.ssim > 0 && verdict.ssim <= 1);
  }
  // Both renders actually happened, and the geometry read-back ran.
  assert.ok(report.slides.every((slide) => slide.sourceRender && slide.powerPointRender));
  assert.equal(report.geometry?.ok, true);
  assert.ok(report.geometry.checked > 0);
  // "Didn't check" must never reappear as a warning.
  assert.equal(report.warnings.some((warning) => warning.code === 'FIDELITY_EVIDENCE_DEFERRED'), false);
});

test('the shipping fidelity gate fails a 40px-shifted duplicate heading', { timeout: 20 * 60 * 1000 }, async () => {
  const { status, report } = await exportThroughTheRealPath(SHIFTED_HEADING_FIXTURE, 'gate-shifted-heading.pptx');
  assert.ok(report, `no fidelity report was produced (status: ${status})`);

  if (!powerPointInstalled) {
    // Keep the same loud, filesystem-backed guard as the clean-path case.
    // Do not infer this from the report: that would conceal a disconnected
    // shipping gate as an unavailable local dependency.
    console.error('\n*** SKIPPED: desktop PowerPoint is not installed on this machine.');
    console.error(`*** evidenceMode=${report.evidenceMode} verificationState=${report.verificationState}`);
    console.error('*** The shifted-heading tripwire only proves anything where PowerPoint is installed.\n');
    assert.equal(report.verificationState, 'unverified',
      'without PowerPoint the export must still succeed, honestly marked unverified');
    return;
  }

  assert.equal(report.evidenceMode, 'full',
    'PowerPoint is installed, so the shipping export path must run full evidence');
  assert.equal(report.verificationState, 'partial', `status was: ${status}`);
  assert.equal(report.failedSlideCount, 1);
  assert.equal(report.slideVerdicts.length, 1);

  const [verdict] = report.slideVerdicts;
  assert.equal(verdict.verdict, 'failed');
  assert.equal(typeof verdict.ssim, 'number', 'the failed verdict must carry a real SSIM');
  assert.equal(typeof verdict.mismatchPercent, 'number');
  assert.ok(
    verdict.reasons.includes('SSIM_BELOW_THRESHOLD') ||
      verdict.reasons.includes('PIXEL_MISMATCH_ABOVE_THRESHOLD'),
    `the deliberate 40px heading shift must fail the visual thresholds: ${JSON.stringify(verdict)}`
  );
  assert.ok(report.slides[0].sourceRender && report.slides[0].powerPointRender,
    'the failed verdict must come from two real renders');
  assert.equal(report.geometry?.ok, true,
    'this is a visual tripwire; native scene geometry itself remains valid');
});
