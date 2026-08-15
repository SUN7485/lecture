'use strict';

// Mission 035's end-to-end proof.  Unlike the deterministic adapter test,
// this opens the real editor, extracts the browser scene, saves through the
// shipping IPC handler, and makes PowerPoint render the candidate.  It is
// deliberately not part of the fast npm test command: desktop PowerPoint is
// required and the two real exports are expensive.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'self-heal-deck.html');
const POWERPOINT_PATHS = [
  'C:\\Program Files\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files (x86)\\Microsoft Office\\Root\\Office16\\POWERPNT.EXE',
  'C:\\Program Files\\Microsoft Office\\Office16\\POWERPNT.EXE'
];
const powerPointInstalled = process.platform === 'win32' && POWERPOINT_PATHS.some((candidate) => fs.existsSync(candidate));

// FIDELITY_ROOT also contains the durable cache directory.  Only timestamped
// folders are evidence runs, so neither the cache nor another support folder
// can be mistaken for this export's report.
function runDirectories(fidelityRoot) {
  if (!fs.existsSync(fidelityRoot)) return [];
  return fs.readdirSync(fidelityRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name))
    .map((entry) => entry.name);
}

async function sceneSummary(page) {
  return page.evaluate(() => {
    const graph = window.__editor.serializeForPptx();
    const slide = graph.slides[1];
    const outlineCard = slide && slide.nodes.find((node) => node.id === 's1:0');
    return {
      slideCount: graph.slides.length,
      bakeCount: graph.bakeCount,
      outlineCard: outlineCard && {
        id: outlineCard.id,
        renderAs: outlineCard.renderAs,
        bounds: outlineCard.bounds,
        bake: outlineCard.bake || null
      }
    };
  });
}

async function exportThroughShippingPath({ fidelityRoot, outputName }) {
  const outputPath = path.join(fidelityRoot, outputName);
  fs.mkdirSync(fidelityRoot, { recursive: true });
  fs.rmSync(outputPath, { force: true });
  const beforeRuns = new Set(runDirectories(fidelityRoot));
  const { app, page } = await launchLve({
    open: FIXTURE,
    exportPath: outputPath,
    // LVE_PYTHON is intentionally NOT supplied here: the real chain must use
    // the caller's inherited runtime selection.  Only transient evidence and
    // its cache are isolated per test invocation.
    extraEnv: { LVE_FIDELITY_ROOT: fidelityRoot, LVE_NO_CACHE: '0' }
  });
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length === 3, null, { timeout: 120000 });
    const beforeScene = await sceneSummary(page);
    const startedAt = Date.now();
    await page.click('#btn-export-pptx');
    await page.waitForFunction(() => /^تم التصدير|^PPTX export /
      .test(document.getElementById('status').textContent || ''), null, { timeout: 20 * 60 * 1000 });
    const elapsedMs = Date.now() - startedAt;
    const status = await page.evaluate(() => document.getElementById('status').textContent || '');
    const afterScene = await sceneSummary(page);
    const created = runDirectories(fidelityRoot).filter((dir) => !beforeRuns.has(dir)).sort();
    const workDir = created.length ? path.join(fidelityRoot, created.at(-1)) : null;
    const reportPath = workDir && path.join(workDir, 'fidelity-report.json');
    const report = reportPath && fs.existsSync(reportPath)
      ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null;
    return { outputPath, status, elapsedMs, beforeScene, afterScene, report };
  } finally {
    await app.close().catch(() => {});
  }
}

test('the shipping self-heal loop bakes the outlined native shape and caches the healed result',
  { timeout: 35 * 60 * 1000 }, async (t) => {
    const fidelityRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-self-heal-real-'));
    t.after(() => fs.rmSync(fidelityRoot, { recursive: true, force: true }));

    const first = await exportThroughShippingPath({
      fidelityRoot,
      outputName: 'self-heal-first.pptx'
    });
    assert.ok(first.report, `no first fidelity report was produced (status: ${first.status})`);

    if (!powerPointInstalled) {
      // This remains a real shipping-export assertion, but a machine without
      // desktop Office cannot exercise visual healing or a full-evidence cache.
      console.error('\n*** SKIPPED: desktop PowerPoint is not installed on this machine.');
      console.error(`*** evidenceMode=${first.report.evidenceMode} verificationState=${first.report.verificationState}`);
      assert.equal(first.report.verificationState, 'unverified');
      return;
    }

    // Before and after the first export, the live editor still produces the
    // original native scene.  This is the public, end-to-end proof that heal
    // candidates are cloned rather than mutating the editor-owned graph.
    for (const scene of [first.beforeScene, first.afterScene]) {
      assert.equal(scene.slideCount, 3);
      assert.equal(scene.bakeCount, 0, 'the fixture must start with no declared bakes');
      assert.deepEqual(scene.outlineCard, {
        id: 's1:0',
        renderAs: 'shape',
        bounds: { x: 155, y: 165, w: 640, h: 320 },
        bake: null
      });
    }

    assert.equal(first.report.evidenceMode, 'full');
    assert.equal(first.report.verificationState, 'verified', `status was: ${first.status}`);
    assert.equal(first.report.failedSlideCount, 0);
    assert.equal(first.report.slideVerdicts.length, 3);
    assert.equal(first.report.slideVerdicts[0].verdict, 'verified');
    assert.equal(first.report.slideVerdicts[2].verdict, 'verified');
    assert.equal(first.report.slides[0].healed, null);
    assert.equal(first.report.slides[2].healed, null);

    const healed = first.report.slides[1];
    assert.equal(first.report.slideVerdicts[1].verdict, 'verified');
    assert.equal(healed.cached, false);
    assert.ok(healed.healed, 'slide 2 must retain its final healing record');
    assert.ok(healed.healed.round >= 1 && healed.healed.round <= 2);
    assert.ok(healed.healed.demotedNodeIds.includes('s1:0'),
      `the missing inside outline must heal by baking the outer shape: ${JSON.stringify(healed.healed)}`);
    assert.ok(healed.bakedByHeal >= 1);
    assert.ok(healed.visualAttempts.length >= 2,
      'the report must retain first-pass and healed visual evidence');
    assert.ok(healed.sourceRender && healed.powerPointRender,
      'the first run must have source and PowerPoint evidence before it heals');

    const second = await exportThroughShippingPath({
      fidelityRoot,
      outputName: 'self-heal-second.pptx'
    });
    assert.ok(second.report, `no cached-run fidelity report was produced (status: ${second.status})`);
    assert.equal(second.report.evidenceMode, 'full');
    assert.equal(second.report.verificationState, 'verified');
    assert.equal(second.report.cache?.enabled, true);
    assert.equal(second.report.cache?.allHit, true,
      `the unchanged second export should reuse all three slide entries: ${JSON.stringify(second.report.cache)}`);
    assert.ok(second.report.cache.hitCount >= 3);
    assert.ok(second.report.slides.filter((slide) => slide.cached).length >= 3,
      'every unchanged slide should declare that its visual proof came from cache');
    assert.equal(second.report.slideVerdicts[1].verdict, 'verified');
    assert.ok(second.report.slides[1].healed?.demotedNodeIds.includes('s1:0'),
      'cache replay must reapply the healed outer-shape demotion before rebuilding the PPTX');
    assert.equal(second.report.source, null,
      'an all-cache hit must skip a new Chromium source render');
    assert.equal(second.report.powerPoint, null,
      'an all-cache hit must skip the expensive PowerPoint/COM render');
    assert.ok(second.elapsedMs < first.elapsedMs * 0.5,
      `cached export should take less than half the first real export (${second.elapsedMs}ms vs ${first.elapsedMs}ms)`);

    const initialVisual = healed.visualAttempts.find((attempt) => attempt.round === 0)?.visual || {};
    console.log(
      `self-heal evidence: slide 2 SSIM ${Number(initialVisual.ssim).toFixed(4)} -> ${Number(healed.visual?.ssim).toFixed(4)}, ` +
      `mismatch ${Number(initialVisual.mismatchPercent).toFixed(3)}% -> ${Number(healed.visual?.mismatchPercent).toFixed(3)}%, ` +
      `cache ${first.elapsedMs}ms -> ${second.elapsedMs}ms`
    );
  });
