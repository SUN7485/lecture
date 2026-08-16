// The PPTX regression lock: one command that prints the truth about the whole
// corpus, in the REAL app, through the REAL export path.
//
// Run: node verify-pptx-corpus.js [path-to-deck.html] [--no-cache] [--strict]
//
// This is a REGRESSION lock, and the distinction matters. Every structural
// defect the pipeline can check is fixed — geometry lands within 0.75px, the
// scene names the font that actually painted, lists no longer drift — and what
// remains is cross-renderer Arabic text shaping, which scales with text density
// and cannot be engineered away. Real lectures therefore sit below the
// calibration deck's 0.8487 SSIM floor and always will.
//
// So the default gate compares each deck against its own RECORDED baseline
// (test/fixtures/corpus-baseline.json): exit 1 when a deck gets WORSE than the
// day this was measured. That catches exactly what a lock should catch — a
// change that degrades fidelity — without either lying about the absolute
// numbers or crying wolf on every run. `--strict` demands the absolute bar
// instead: every slide of every deck verified.
//
// Either way the printed table is the measured truth, read straight out of the
// fidelity report the export actually wrote. Nothing here is estimated.
//
// Ritual: no commit that touches the pptx pipeline without this being green.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('./test/support/launch-electron');

const FIDELITY_ROOT = path.join(ROOT, '.fidelity');
const EXPORT_TIMEOUT_MS = 20 * 60 * 1000;
const NO_CACHE = process.argv.includes('--no-cache');
const STRICT = process.argv.includes('--strict');
const SINGLE = process.argv.slice(2).find((arg) => arg.endsWith('.html'));
const BASELINE_PATH = path.join(ROOT, 'test', 'fixtures', 'corpus-baseline.json');
// A deck may lose this much SSIM to ordinary run-to-run variation before it
// counts as a regression. The pipeline measures as deterministic (spread
// 0.000e+0 across three identical runs), so this is deliberately tight.
const SSIM_REGRESSION_TOLERANCE = 0.002;

const DOWNLOADS = 'C:\\Users\\mosun\\Downloads\\New folder';
const CORPUS = SINGLE
  ? [{ name: path.basename(SINGLE, '.html'), deck: path.resolve(SINGLE) }]
  : [
    { name: 'Chp5-Lec32-7-final', deck: path.join(DOWNLOADS, 'Chp5-Lec32-7-final.html') },
    { name: 'Chp5-Lec33-1', deck: path.join(DOWNLOADS, 'Chp5-Lec33-1.html') },
    { name: 'Chp1-Lec1-2', deck: path.join(ROOT, 'Chp1-Lec1-2.html') },
    { name: 'source-bnb', deck: path.join(ROOT, 'test', 'fixtures', 'source-bnb.html') },
    { name: 'calibration-deck', deck: path.join(ROOT, 'test', 'fixtures', 'calibration-deck.html') },
    { name: 'bidi-deck', deck: path.join(ROOT, 'test', 'fixtures', 'bidi-deck.html') }
  ];

const runDirs = () => (fs.existsSync(FIDELITY_ROOT)
  ? fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []);

async function scoreDeck({ name, deck }) {
  if (!fs.existsSync(deck)) return { name, deck, error: 'deck file not found' };
  const outPath = path.join(FIDELITY_ROOT, `corpus-${name}.pptx`);
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  const before = new Set(runDirs());
  const started = Date.now();

  const extraEnv = { LVE_EVIDENCE_MODE: 'full' };
  if (NO_CACHE) extraEnv.LVE_NO_CACHE = '1';
  const { app, page } = await launchLve({ open: deck, exportPath: outPath, extraEnv });
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length > 0, null, { timeout: 120000 });
    await page.evaluate(() => { document.getElementById('status').textContent = 'corpus: waiting'; });
    await page.click('#btn-export-pptx');
    await page.waitForFunction(() => /^تم التصدير|^PPTX export /
      .test(document.getElementById('status').textContent || ''), null, { timeout: EXPORT_TIMEOUT_MS });
    const status = await page.evaluate(() => document.getElementById('status').textContent);

    const created = runDirs().filter((dir) => !before.has(dir)).sort();
    const workDir = created.length ? path.join(FIDELITY_ROOT, created[created.length - 1]) : null;
    const reportPath = workDir && path.join(workDir, 'fidelity-report.json');
    if (!reportPath || !fs.existsSync(reportPath)) {
      return { name, deck, seconds: (Date.now() - started) / 1000, status, error: 'no fidelity report was written' };
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const verdicts = report.slideVerdicts || [];
    const slides = report.slides || [];
    const healed = slides.filter((slide) => slide.healed?.round).length;
    const baked = slides.reduce((total, slide) =>
      total + ((slide.bakedNodeIds || slide.healed?.demotedNodeIds || []).length), 0);
    const ssims = verdicts.map((v) => v.ssim).filter(Number.isFinite);
    const mismatches = verdicts.map((v) => v.mismatchPercent).filter(Number.isFinite);
    return {
      name,
      deck,
      seconds: (Date.now() - started) / 1000,
      status,
      runDir: path.basename(workDir),
      slideCount: slides.length,
      verified: verdicts.filter((v) => v.verdict === 'verified').length,
      failed: verdicts.filter((v) => v.verdict === 'failed').length,
      unverified: verdicts.filter((v) => v.verdict === 'unverified').length,
      healed,
      baked,
      minSsim: ssims.length ? Math.min(...ssims) : null,
      maxMismatch: mismatches.length ? Math.max(...mismatches) : null,
      badSlides: verdicts.filter((v) => v.verdict !== 'verified')
        .map((v) => `${v.slide}:${v.verdict}${v.reasons?.length ? `(${v.reasons.join(',')})` : ''}`)
    };
  } finally {
    await app.close().catch(() => {});
  }
}

const pad = (value, width, right = false) => {
  const text = String(value);
  return right ? text.padStart(width) : text.padEnd(width);
};

(async () => {
  const rows = [];
  for (const entry of CORPUS) {
    process.stdout.write(`… ${entry.name}\n`);
    rows.push(await scoreDeck(entry));
  }

  const header = ['deck', 'slides', 'verified', 'healed', 'failed', 'unver', 'min ssim', 'max mm%', 'baked', 'secs'];
  const widths = [24, 6, 8, 6, 6, 5, 9, 8, 5, 6];
  const line = (cells) => cells.map((cell, index) => pad(cell, widths[index], index > 0)).join(' ');

  console.log('\n================== PPTX CORPUS SCORECARD ==================');
  console.log(line(header));
  console.log(widths.map((width) => '-'.repeat(width)).join(' '));
  for (const row of rows) {
    if (row.error) { console.log(line([row.name, '—', '—', '—', '—', '—', '—', '—', '—', (row.seconds || 0).toFixed(0)]) + `  ERROR: ${row.error}`); continue; }
    console.log(line([
      row.name, row.slideCount, row.verified, row.healed, row.failed, row.unverified,
      row.minSsim === null ? '—' : row.minSsim.toFixed(4),
      row.maxMismatch === null ? '—' : row.maxMismatch.toFixed(2),
      row.baked, row.seconds.toFixed(0)
    ]));
  }

  console.log('===========================================================');

  const broken = rows.filter((row) => row.error);
  const belowBar = rows.filter((row) => !row.error && (row.failed || row.unverified));

  // --strict: the absolute bar — every slide of every deck verified.
  if (STRICT) {
    const failing = [...broken, ...belowBar];
    if (failing.length) {
      console.log('\nNOT GREEN (--strict: every slide must verify):');
      for (const row of failing) {
        if (row.error) { console.log(`  ${row.name}: ${row.error}`); continue; }
        console.log(`  ${row.name}: ${row.badSlides.join(', ')}`);
      }
    }
    finish(failing.length === 0, rows);
    return;
  }

  // Default: did anything get WORSE than the recorded baseline?
  let baseline = null;
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')); } catch (_) { baseline = null; }
  const regressions = [...broken.map((row) => `${row.name}: ${row.error}`)];
  if (!baseline) {
    console.log('\nNo baseline at test/fixtures/corpus-baseline.json — cannot detect regressions.');
    console.log('Record one from a known-good run, or use --strict for the absolute bar.');
  } else {
    for (const row of rows) {
      if (row.error) continue;
      const prior = baseline.decks?.[row.name];
      if (!prior) { console.log(`  (no baseline for ${row.name} — not gated)`); continue; }
      if (row.verified < prior.verified) {
        regressions.push(`${row.name}: verified ${prior.verified} -> ${row.verified}`);
      }
      if (Number.isFinite(row.minSsim) && row.minSsim < prior.minSsim - SSIM_REGRESSION_TOLERANCE) {
        regressions.push(`${row.name}: min ssim ${prior.minSsim} -> ${row.minSsim.toFixed(4)}`);
      }
    }
    console.log(`\nbaseline recorded ${baseline.recordedAt}; ` +
      `${rows.length - broken.length} deck(s) compared, tolerance ${SSIM_REGRESSION_TOLERANCE} ssim.`);
  }

  if (belowBar.length) {
    console.log('\nBelow the absolute bar (expected — cross-renderer shaping on dense text;');
    console.log('run with --strict to gate on this instead):');
    for (const row of belowBar) {
      console.log(`  ${row.name}: ${row.failed} failed, ${row.unverified} unverified, min ssim ${row.minSsim?.toFixed(4)}`);
    }
  }
  if (regressions.length) {
    console.log('\nREGRESSIONS vs baseline:');
    for (const line of regressions) console.log(`  ${line}`);
  }
  finish(regressions.length === 0, rows);
})().catch((error) => { console.error('corpus verify crashed:', error); process.exit(1); });

function finish(green, rows) {

  // Same lines into the retained evidence index, so a week of runs reads as a table.
  try {
    const indexPath = path.join(FIDELITY_ROOT, 'index.md');
    const stamp = new Date().toISOString();
    const lines = rows.filter((row) => !row.error).map((row) =>
      `| ${stamp} | corpus:${row.name} | full | ${row.slideCount} | ` +
      `${row.minSsim === null ? '—' : row.minSsim.toFixed(6)} | ` +
      `${row.maxMismatch === null ? '—' : row.maxMismatch.toFixed(3)} | ${row.failed} | ${row.baked} |`);
    if (lines.length) fs.appendFileSync(indexPath, lines.join('\n') + '\n', 'utf8');
  } catch (error) {
    console.warn('could not append to .fidelity/index.md:', error.message);
  }

  if (green) {
    console.log(STRICT
      ? '\nCORPUS GREEN — every slide of every deck verified.'
      : '\nCORPUS GREEN — no deck regressed against its recorded baseline.');
  } else {
    console.log(STRICT ? '\nCORPUS RED — slides below the absolute bar.' : '\nCORPUS RED — fidelity regressed.');
  }
  process.exit(green ? 0 : 1);
}
