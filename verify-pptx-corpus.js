// The PPTX regression lock: one command that prints the truth about the whole
// corpus, in the REAL app, through the REAL export path.
//
// Run: node verify-pptx-corpus.js [path-to-deck.html] [--no-cache]
//
// Exit 0 ONLY when every slide of every deck is verified (a slide the self-heal
// repaired counts as verified — it was measured and it passed). Anything else
// exits 1 and names the slides. There are no derived or estimated numbers here:
// every cell is read back out of the fidelity report the export actually wrote.
//
// Ritual: no commit that touches the pptx pipeline without this being green.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('./test/support/launch-electron');

const FIDELITY_ROOT = path.join(ROOT, '.fidelity');
const EXPORT_TIMEOUT_MS = 20 * 60 * 1000;
const NO_CACHE = process.argv.includes('--no-cache');
const SINGLE = process.argv.slice(2).find((arg) => arg.endsWith('.html'));

const DOWNLOADS = 'C:\\Users\\mosun\\Downloads\\New folder';
const CORPUS = SINGLE
  ? [{ name: path.basename(SINGLE, '.html'), deck: path.resolve(SINGLE) }]
  : [
    { name: 'Chp5-Lec32-7-final', deck: path.join(DOWNLOADS, 'Chp5-Lec32-7-final.html') },
    { name: 'Chp5-Lec33-1', deck: path.join(DOWNLOADS, 'Chp5-Lec33-1.html') },
    { name: 'Chp1-Lec1-2', deck: path.join(ROOT, 'Chp1-Lec1-2.html') },
    { name: 'source-bnb', deck: path.join(ROOT, 'test', 'fixtures', 'source-bnb.html') },
    { name: 'calibration-deck', deck: path.join(ROOT, 'test', 'fixtures', 'calibration-deck.html') }
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

  const failing = rows.filter((row) => row.error || row.failed || row.unverified);
  console.log('===========================================================');
  if (failing.length) {
    console.log('\nNOT GREEN:');
    for (const row of failing) {
      if (row.error) { console.log(`  ${row.name}: ${row.error}`); continue; }
      console.log(`  ${row.name}: ${row.badSlides.join(', ')}`);
    }
  }

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

  const green = failing.length === 0;
  console.log(green ? '\nCORPUS GREEN — every slide verified.' : '\nCORPUS RED.');
  process.exit(green ? 0 : 1);
})().catch((error) => { console.error('corpus verify crashed:', error); process.exit(1); });
