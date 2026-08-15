'use strict';

// MISSION 032 / PHASE 0 — "first truth".
//
// The cheapest possible end-to-end run: drive the real app over the two real
// lectures with evidenceMode=full, and find out how far the PPTX actually is
// from the HTML. Compare FAILURES are expected here — the thresholds
// (SSIM 0.9995 / 0.02% pixels) were never validated against a real run and
// mission 034 recalibrates them from this data. A refusal or a missing report
// is the only real failure.
//
// Mission 033 removed the throwaway in-page SVG/gradient mutations this driver
// carried in mission 032: scene v2 bakes unmappable elements per node and maps
// linear-gradients to native fills, so every corpus deck now exports unmodified.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('../../test/support/launch-electron');

const CORPUS = [
  { name: 'Chp5-Lec32-7-final', deck: 'C:\\Users\\mosun\\Downloads\\New folder\\Chp5-Lec32-7-final.html' },
  { name: 'Chp5-Lec33-1', deck: 'C:\\Users\\mosun\\Downloads\\New folder\\Chp5-Lec33-1.html' },
  { name: 'Chp1-Lec1-2', deck: path.join(ROOT, 'Chp1-Lec1-2.html') },
  { name: 'source-bnb', deck: path.join(ROOT, 'test', 'fixtures', 'source-bnb.html') }
];
const FIDELITY_ROOT = path.join(ROOT, '.fidelity');
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;

function runDirs() {
  if (!fs.existsSync(FIDELITY_ROOT)) return [];
  return fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d\d-\d\dT/.test(entry.name))
    .map((entry) => entry.name);
}

async function exportDeck({ name, deck }) {
  const outPath = path.join(FIDELITY_ROOT, `out-${name}.pptx`);
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  const before = new Set(runDirs());

  console.log(`\n=== ${name} ===`);
  console.log(`  deck: ${deck}`);
  const { app, page } = await launchLve({
    open: deck,
    exportPath: outPath,
    // Corpus evidence must be a fresh browser-to-Office measurement, never a
    // cache replay. Cache behavior has its own focused Mission 035 proof.
    extraEnv: { LVE_EVIDENCE_MODE: 'full', LVE_NO_CACHE: '1' }
  });

  try {
    await page.waitForFunction(
      () => window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length > 0,
      null, { timeout: 120000 });
    const slideCount = await page.evaluate(() => window.__editor.doc.querySelectorAll('.slide').length);
    console.log(`  slides: ${slideCount}`);

    // Scene v2 shape check, before the export: nothing may refuse any more.
    const scene = await page.evaluate(() => {
      const graph = window.__editor.serializeForPptx();
      const nodes = graph.slides.flatMap((slide) => slide.nodes);
      return {
        schemaVersion: graph.schemaVersion,
        errors: graph.errors.length,
        bakeCount: graph.bakeCount,
        bakeNodes: nodes.filter((node) => node.renderAs === 'bake').length,
        gradientNodes: nodes.filter((node) => node.style && node.style.gradient).length,
        noteNodes: nodes.filter((node) => (node.notes || []).length).length
      };
    });
    console.log(`  scene v${scene.schemaVersion}: errors=${scene.errors} bakes=${scene.bakeCount} ` +
      `gradients=${scene.gradientNodes} noted=${scene.noteNodes}`);


    // The renderer's own completion signal: exportPptxDirect() writes a
    // terminal message into #status either way (see src/renderer.js).
    await page.evaluate(() => { document.getElementById('status').textContent = 'lve-first-truth: waiting'; });
    await page.click('#btn-export-pptx');
    console.log('  export clicked, waiting for the pipeline (up to 10 min)…');

    const started = Date.now();
    await page.waitForFunction(() => {
      const text = document.getElementById('status').textContent || '';
      return /^تم التصدير|^PPTX export /.test(text);
    }, null, { timeout: EXPORT_TIMEOUT_MS });
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    console.log(`  status after ${Math.round((Date.now() - started) / 1000)}s: ${status}`);

    const created = runDirs().filter((dir) => !before.has(dir)).sort();
    const workDir = created.length ? path.join(FIDELITY_ROOT, created[created.length - 1]) : null;
    return { name, deck, slideCount, scene, status, workDir };
  } finally {
    await app.close().catch(() => {});
  }
}

function summarise(workDir) {
  const reportPath = path.join(workDir, 'fidelity-report.json');
  if (!fs.existsSync(reportPath)) return { reportPath, ok: false };
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const slides = report.slides || [];
  const rows = slides.map((slide) => ({
    slide: slide.slideNumber ?? slide.index + 1,
    ssim: slide.visual?.ssim ?? null,
    mismatchPercent: slide.visual?.mismatchPercent ?? null
  }));
  const ssims = rows.map((row) => row.ssim).filter(Number.isFinite).sort((a, b) => a - b);
  const mismatches = rows.map((row) => row.mismatchPercent).filter(Number.isFinite);
  const median = (values) => (values.length
    ? (values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2)
    : null);
  return {
    reportPath,
    ok: true,
    stage: report.stage,
    slideCount: slides.length,
    scored: ssims.length,
    minSsim: ssims[0] ?? null,
    medianSsim: median(ssims),
    maxSsim: ssims[ssims.length - 1] ?? null,
    maxMismatch: mismatches.length ? Math.max(...mismatches) : null,
    minMismatch: mismatches.length ? Math.min(...mismatches) : null,
    failures: report.failures?.length || 0,
    warnings: report.warnings?.length || 0,
    sourceRenders: slides.filter((slide) => slide.sourceRender).length,
    powerPointRenders: slides.filter((slide) => slide.powerPointRender).length,
    rows
  };
}

(async () => {
  const results = [];
  for (const entry of CORPUS) {
    try {
      results.push(await exportDeck(entry));
    } catch (error) {
      console.error(`  ${entry.name} FAILED: ${error.message}`);
      results.push({ ...entry, error: error.message, workDir: null });
    }
  }

  console.log('\n\n================ FIRST TRUTH ================');
  let produced = 0;
  for (const result of results) {
    console.log(`\n## ${result.name}`);
    if (result.error) { console.log(`  run failed: ${result.error}`); continue; }
    console.log(`  run dir: ${result.workDir ? path.basename(result.workDir) : '(none created)'}`);
    if (result.scene) console.log(`  scene: errors=${result.scene.errors} bakes=${result.scene.bakeCount} gradients=${result.scene.gradientNodes}`);
    if (!result.workDir) continue;
    const summary = summarise(result.workDir);
    if (!summary.ok) { console.log(`  no report at ${summary.reportPath}`); continue; }
    produced += 1;
    console.log(`  report: ${summary.reportPath}`);
    console.log(`  stage=${summary.stage} slides=${summary.slideCount} scored=${summary.scored} ` +
      `sourceRenders=${summary.sourceRenders} powerPointRenders=${summary.powerPointRenders}`);
    console.log(`  ssim  min=${summary.minSsim} median=${summary.medianSsim} max=${summary.maxSsim}`);
    console.log(`  mismatch%  min=${summary.minMismatch} max=${summary.maxMismatch}`);
    console.log(`  failures=${summary.failures} warnings=${summary.warnings}`);
    console.log('  per-slide:');
    for (const row of summary.rows) {
      console.log(`    ${String(row.slide).padStart(3)} | ssim ${row.ssim === null ? '—' : row.ssim.toFixed(6)}` +
        ` | mismatch ${row.mismatchPercent === null ? '—' : row.mismatchPercent.toFixed(3) + '%'}`);
    }
  }
  console.log('\n============================================');
  if (produced !== CORPUS.length) {
    console.error(`\nFAILED: ${produced}/${CORPUS.length} decks produced a report.`);
    process.exit(1);
  }
  console.log(`\nOK: ${produced}/${CORPUS.length} decks produced a report.`);
})().catch((error) => {
  console.error('first-truth crashed:', error);
  process.exit(1);
});
