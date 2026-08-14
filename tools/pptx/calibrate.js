'use strict';

// MISSION 034 — derive the fidelity thresholds from measurement.
//
// Runs the full-evidence export over the calibration deck (and any extra decks
// given on the command line) N times, collects every per-slide metric into
// .fidelity/calibration.json, and prints the distribution the thresholds are
// fitted to. The numbers are OUTPUTS of this script; inventing them is the one
// thing this mission forbids.
//
//   node tools/pptx/calibrate.js [--runs 3] [deck.html ...]

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('../../test/support/launch-electron');

const FIDELITY_ROOT = path.join(ROOT, '.fidelity');
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;

const argv = process.argv.slice(2);
const runsFlag = argv.indexOf('--runs');
const RUNS = runsFlag >= 0 ? Number(argv[runsFlag + 1]) : 3;
const extraDecks = argv.filter((value, index) =>
  value.endsWith('.html') && (runsFlag < 0 || index !== runsFlag + 1));

const DECKS = extraDecks.length
  ? extraDecks.map((deck) => ({ name: path.basename(deck, '.html'), deck: path.resolve(deck) }))
  : [{ name: 'calibration-deck', deck: path.join(ROOT, 'test', 'fixtures', 'calibration-deck.html') }];

function runDirs() {
  if (!fs.existsSync(FIDELITY_ROOT)) return [];
  return fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function exportOnce({ name, deck }, run) {
  const outPath = path.join(FIDELITY_ROOT, `calib-${name}.pptx`);
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  const before = new Set(runDirs());
  const { app, page } = await launchLve({
    open: deck, exportPath: outPath, extraEnv: { LVE_EVIDENCE_MODE: 'full' }
  });
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length > 0, null, { timeout: 120000 });
    await page.evaluate(() => { document.getElementById('status').textContent = 'calibrate: waiting'; });
    await page.click('#btn-export-pptx');
    await page.waitForFunction(() => /^Exported editable PPTX|^PPTX export /
      .test(document.getElementById('status').textContent || ''), null, { timeout: EXPORT_TIMEOUT_MS });
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    const created = runDirs().filter((dir) => !before.has(dir)).sort();
    const workDir = created.length ? path.join(FIDELITY_ROOT, created[created.length - 1]) : null;
    console.log(`  ${name} run ${run + 1}/${RUNS}: ${status.slice(0, 90)}`);
    return { workDir, status };
  } finally {
    await app.close().catch(() => {});
  }
}

function readMetrics(workDir, deckName, run) {
  const reportPath = path.join(workDir, 'fidelity-report.json');
  if (!fs.existsSync(reportPath)) return [];
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  return (report.slides || []).map((slide) => {
    const regions = slide.visual?.regions || [];
    return {
      deck: deckName,
      run,
      slide: slide.slideNumber ?? slide.index + 1,
      ssim: slide.visual?.ssim ?? null,
      mismatchPercent: slide.visual?.mismatchPercent ?? null,
      largestRegionArea: regions.length ? Math.max(...regions.map((region) => region.area || 0)) : 0,
      regionCount: regions.length
    };
  });
}

const quantile = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
  : null);

function describe(label, values, digits) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return `${label}: no data`;
  const fmt = (value) => value.toFixed(digits);
  return `${label}: n=${sorted.length} min=${fmt(sorted[0])} p05=${fmt(quantile(sorted, 0.05))} ` +
    `median=${fmt(quantile(sorted, 0.5))} p95=${fmt(quantile(sorted, 0.95))} max=${fmt(sorted[sorted.length - 1])}`;
}

(async () => {
  const rows = [];
  for (const entry of DECKS) {
    console.log(`\n=== ${entry.name} ===`);
    for (let run = 0; run < RUNS; run += 1) {
      const { workDir } = await exportOnce(entry, run);
      if (workDir) rows.push(...readMetrics(workDir, entry.name, run));
    }
  }

  const outPath = path.join(FIDELITY_ROOT, 'calibration.json');
  fs.writeFileSync(outPath, JSON.stringify({ runs: RUNS, decks: DECKS.map((d) => d.name), rows }, null, 2), 'utf8');

  const ssims = rows.map((row) => row.ssim);
  const mismatches = rows.map((row) => row.mismatchPercent);
  console.log('\n================ DISTRIBUTION ================');
  console.log(describe('ssim      ', ssims, 6));
  console.log(describe('mismatch% ', mismatches, 4));
  console.log(describe('regionArea', rows.map((row) => row.largestRegionArea), 0));

  console.log('\nworst 10 slides by ssim:');
  for (const row of rows.slice().sort((a, b) => (a.ssim ?? 1) - (b.ssim ?? 1)).slice(0, 10)) {
    console.log(`  ${row.deck} slide ${String(row.slide).padStart(2)} run ${row.run} ` +
      `ssim=${row.ssim?.toFixed(6)} mismatch=${row.mismatchPercent?.toFixed(3)}% regions=${row.regionCount}`);
  }

  // Per-slide spread across runs — a slide whose score moves between identical
  // runs is telling us the pipeline is not deterministic, which would make any
  // threshold fitted to it meaningless.
  const bySlide = new Map();
  for (const row of rows) {
    const key = `${row.deck}#${row.slide}`;
    if (!bySlide.has(key)) bySlide.set(key, []);
    bySlide.get(key).push(row.ssim);
  }
  let worstSpread = 0, worstKey = null;
  for (const [key, values] of bySlide) {
    const clean = values.filter(Number.isFinite);
    if (clean.length < 2) continue;
    const spread = Math.max(...clean) - Math.min(...clean);
    if (spread > worstSpread) { worstSpread = spread; worstKey = key; }
  }
  console.log(`\nlargest ssim spread across runs: ${worstSpread.toExponential(3)} (${worstKey || 'n/a'})`);

  const minSsim = Math.min(...ssims.filter(Number.isFinite));
  const maxMismatch = Math.max(...mismatches.filter(Number.isFinite));
  console.log('\n---- derivation inputs ----');
  console.log(`min observed ssim      = ${minSsim.toFixed(6)}  ->  floor = min - 0.005 = ${(minSsim - 0.005).toFixed(6)}`);
  console.log(`max observed mismatch% = ${maxMismatch.toFixed(4)}  ->  budget = max * 1.5 = ${(maxMismatch * 1.5).toFixed(4)}`);
  console.log(`\nwrote ${outPath} (${rows.length} slide observations)`);
})().catch((error) => { console.error('calibrate failed:', error); process.exit(1); });
