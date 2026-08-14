'use strict';

// Diagnostic: export a deck, then ask python-pptx whether every emitted shape
// landed where the browser measured it. Runs in `native` evidence mode because
// geometry needs no PowerPoint render — it is a property of the written file.
//
//   node tools/pptx/diagnose-geometry.js [deckPath]

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ROOT, launchLve } = require('../../test/support/launch-electron');

const DECK = process.argv[2] || path.join(ROOT, 'Chp1-Lec1-2.html');
const FIDELITY_ROOT = path.join(ROOT, '.fidelity');

function runAudit(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('py', ['-X', 'utf8', path.join(ROOT, 'tools', 'pptx', 'audit_geometry.py')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr || `audit exited ${code}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(stdout.slice(0, 500))); }
    });
    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

(async () => {
  const outPath = path.join(FIDELITY_ROOT, 'geometry-probe.pptx');
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  // A refused export leaves the previous file in place; auditing that would
  // silently report the last run's geometry as if it were this one's.
  fs.rmSync(outPath, { force: true });
  const before = new Set(fs.readdirSync(FIDELITY_ROOT));
  const { app, page } = await launchLve({
    open: DECK, exportPath: outPath, extraEnv: { LVE_EVIDENCE_MODE: 'native' }
  });
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length > 0, null, { timeout: 120000 });
    const sceneGraph = await page.evaluate(() => window.__editor.serializeForPptx());
    console.log(`deck: ${path.basename(DECK)} — ${sceneGraph.slides.length} slides, ${sceneGraph.bakeCount} bakes`);

    await page.evaluate(() => { document.getElementById('status').textContent = 'probe: waiting'; });
    await page.click('#btn-export-pptx');
    await page.waitForFunction(() => /^Exported editable PPTX|^PPTX export /
      .test(document.getElementById('status').textContent || ''), null, { timeout: 600000 });
    const status = await page.evaluate(() => document.getElementById('status').textContent);
    console.log('status:', status);
    if (!fs.existsSync(outPath)) throw new Error('no pptx produced');

    const audit = await runAudit({ pptxPath: outPath, sceneGraph, tolerancePx: 0.75 });
    console.log(`\ngeometry: ok=${audit.ok} checked=${audit.checked} ` +
      `mismatches=${audit.mismatchCount} unmatchedNodes=${audit.unmatchedCount}`);
    for (const item of (audit.mismatches || []).slice(0, 12)) {
      console.log(`  ${item.id} [${item.renderAs}] worst=${item.worstPx}px delta=${JSON.stringify(item.deltaPx)}`);
    }
    if (audit.unmatched?.length) console.log('  unmatched sample:', audit.unmatched.slice(0, 8).join(', '));
    console.log(`\nprobe pptx: ${outPath}`);
    // Leave the file for follow-up inspection, drop any run dir we created.
    for (const entry of fs.readdirSync(FIDELITY_ROOT)) {
      if (!before.has(entry) && /^\d{4}-/.test(entry)) {
        fs.rmSync(path.join(FIDELITY_ROOT, entry), { recursive: true, force: true });
      }
    }
    process.exitCode = audit.ok ? 0 : 1;
  } finally {
    await app.close().catch(() => {});
  }
})().catch((error) => { console.error('probe failed:', error.message); process.exit(1); });
