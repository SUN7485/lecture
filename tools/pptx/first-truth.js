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
// TEMPORARY: the two in-page mutations below exist only because scene v1
// refuses any deck containing an <svg> (editor.js `unsupported()`) or any
// non-none backgroundImage — and every real lecture has both (SVG figures +
// gradient covers). Mission 033 fixes this properly (per-node bake + native
// a:gradFill); both hacks die with it.
//
// They are safe for a baseline measurement because BOTH sides of the compare
// read the same mutated DOM: the scene graph comes from `serializeForPptx()`
// and the reference render from `getCleanHtml()`, each taken after mutation.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('../../test/support/launch-electron');

const CORPUS = [
  { name: 'Chp5-Lec32-7-final', deck: 'C:\\Users\\mosun\\Downloads\\New folder\\Chp5-Lec32-7-final.html' },
  { name: 'Chp5-Lec33-1', deck: 'C:\\Users\\mosun\\Downloads\\New folder\\Chp5-Lec33-1.html' }
];
const FIDELITY_ROOT = path.join(ROOT, '.fidelity');
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
const SVG_RASTERIZE_TIMEOUT_MS = 10 * 1000;

function runDirs() {
  if (!fs.existsSync(FIDELITY_ROOT)) return [];
  return fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Replace every inline <svg> inside a slide with a PNG of itself, at the same
 * box. Runs in the page so it uses the same Chromium that measured the scene.
 */
async function rasterizeInlineSvgs(page, timeoutMs) {
  return page.evaluate(async (budgetMs) => {
    const doc = window.__editor.doc;
    const slides = Array.from(doc.querySelectorAll('.slide'));
    const result = { converted: 0, dropped: 0, notes: [] };

    const toPng = (svg, rect) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), budgetMs);
      try {
        const clone = svg.cloneNode(true);
        if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        if (!clone.getAttribute('width')) clone.setAttribute('width', String(rect.width));
        if (!clone.getAttribute('height')) clone.setAttribute('height', String(rect.height));
        const markup = new XMLSerializer().serializeToString(clone);
        const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
        const image = new Image();
        image.onload = () => {
          try {
            const canvas = doc.createElement('canvas');
            canvas.width = Math.max(1, Math.round(rect.width * 2));
            canvas.height = Math.max(1, Math.round(rect.height * 2));
            const ctx = canvas.getContext('2d');
            ctx.scale(2, 2);
            ctx.drawImage(image, 0, 0, rect.width, rect.height);
            clearTimeout(timer);
            resolve(canvas.toDataURL('image/png'));
          } catch (error) { clearTimeout(timer); reject(error); }
        };
        image.onerror = () => { clearTimeout(timer); reject(new Error('image decode failed')); };
        image.src = url;
      } catch (error) { clearTimeout(timer); reject(error); }
    });

    for (let index = 0; index < slides.length; index += 1) {
      for (const svg of Array.from(slides[index].querySelectorAll('svg'))) {
        const rect = svg.getBoundingClientRect();
        const box = { width: rect.width || 100, height: rect.height || 100 };
        try {
          const dataUrl = await toPng(svg, box);
          const img = doc.createElement('img');
          img.src = dataUrl;
          img.setAttribute('width', String(Math.round(box.width)));
          img.setAttribute('height', String(Math.round(box.height)));
          img.style.width = box.width + 'px';
          img.style.height = box.height + 'px';
          svg.replaceWith(img);
          result.converted += 1;
        } catch (error) {
          svg.remove();
          result.dropped += 1;
          result.notes.push(`svg dropped: ${index}`);
          console.warn(`svg dropped: ${index}`);
        }
      }
    }
    return result;
  }, timeoutMs);
}

/**
 * Flatten every CSS background-image (gradient covers, mostly) to the average
 * of its colour stops, so scene v1 stops rejecting the node. Throwaway.
 */
async function flattenBackgroundImages(page) {
  return page.evaluate(() => {
    const doc = window.__editor.doc;
    const result = { flattened: 0, gradients: 0 };
    for (const el of Array.from(doc.querySelectorAll('.slide, .slide *'))) {
      const backgroundImage = getComputedStyle(el).backgroundImage;
      if (!backgroundImage || backgroundImage === 'none') continue;
      const stops = (backgroundImage.match(/rgba?\([^)]*\)/g) || [])
        .map((token) => token.match(/[\d.]+/g).map(Number))
        .filter((parts) => parts.length < 4 || parts[3] > 0);
      if (stops.length) {
        const mean = (channel) => Math.round(stops.reduce((sum, parts) => sum + parts[channel], 0) / stops.length);
        el.style.backgroundColor = `rgb(${mean(0)}, ${mean(1)}, ${mean(2)})`;
        result.gradients += 1;
      }
      el.style.backgroundImage = 'none';
      result.flattened += 1;
    }
    return result;
  });
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
    extraEnv: { LVE_EVIDENCE_MODE: 'full' }
  });

  try {
    await page.waitForFunction(
      () => window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length > 0,
      null, { timeout: 120000 });
    const slideCount = await page.evaluate(() => window.__editor.doc.querySelectorAll('.slide').length);
    console.log(`  slides: ${slideCount}`);

    const svg = await rasterizeInlineSvgs(page, SVG_RASTERIZE_TIMEOUT_MS);
    console.log(`  svg workaround: ${svg.converted} rasterized, ${svg.dropped} dropped`);
    const backgrounds = await flattenBackgroundImages(page);
    console.log(`  background workaround: ${backgrounds.flattened} flattened (${backgrounds.gradients} had colour stops)`);

    // The renderer's own completion signal: exportPptxDirect() writes a
    // terminal message into #status either way (see src/renderer.js).
    await page.evaluate(() => { document.getElementById('status').textContent = 'lve-first-truth: waiting'; });
    await page.click('#btn-export-pptx');
    console.log('  export clicked, waiting for the pipeline (up to 10 min)…');

    const started = Date.now();
    await page.waitForFunction(() => {
      const text = document.getElementById('status').textContent || '';
      return /^Exported editable PPTX|^PPTX export /.test(text);
    }, null, { timeout: EXPORT_TIMEOUT_MS });
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    console.log(`  status after ${Math.round((Date.now() - started) / 1000)}s: ${status}`);

    const created = runDirs().filter((dir) => !before.has(dir)).sort();
    const workDir = created.length ? path.join(FIDELITY_ROOT, created[created.length - 1]) : null;
    return { name, deck, slideCount, svg, backgrounds, status, workDir };
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
