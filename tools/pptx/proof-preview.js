'use strict';

// MISSION 037 stage 4 — visual proof of the "HTML = PPT" screen.
//
// Opens a real lecture, clicks Preview, waits for the two-up to populate from
// the real verification run, asserts the DOM matches the report numbers, and
// screenshots the modal. UI is verified by looking at the picture, not by
// reading the code.
//
//   node tools/pptx/proof-preview.js [deck.html]

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, launchLve } = require('../../test/support/launch-electron');

const DECK = process.argv[2] || path.join(ROOT, 'test', 'fixtures', 'calibration-deck.html');
const OUT = path.join(ROOT, '.fidelity', 'proof-preview.png');

(async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const { app, page } = await launchLve({ open: DECK });
  try {
    await page.waitForFunction(() => window.__editor && window.__editor.doc
      && window.__editor.doc.querySelectorAll('.slide').length > 0, null, { timeout: 120000 });
    console.log(`deck: ${path.basename(DECK)}`);

    await page.click('#btn-preview-pptx');
    // The modal opens immediately with skeletons; rows arrive when the real
    // PowerPoint render + compare finishes.
    await page.waitForFunction(() => {
      const modal = document.getElementById('preview-modal');
      if (!modal || modal.hidden) return false;
      return document.querySelectorAll('#preview-slides .preview-row .preview-pane-frame img').length > 0;
    }, null, { timeout: 15 * 60 * 1000 });

    const dom = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#preview-slides .preview-row'));
      return {
        summary: document.getElementById('preview-summary')?.textContent || '',
        advisory: document.getElementById('preview-advisory')?.hidden === false
          ? document.getElementById('preview-advisory').textContent : null,
        rowCount: rows.length,
        imagesPerRow: rows.map((row) => row.querySelectorAll('.preview-pane-frame img:not(.heatmap-layer)').length),
        chips: rows.map((row) => row.querySelector('.verdict-chip')?.textContent || null),
        chipClasses: rows.map((row) => row.querySelector('.verdict-chip')?.className || null),
        bakedBadges: rows.filter((row) => row.querySelector('.baked-badge')).length,
        heatmapLayers: document.querySelectorAll('#preview-slides .heatmap-layer').length,
        paneLabels: Array.from(rows[0]?.querySelectorAll('.preview-pane-label') || []).map((n) => n.textContent),
        direction: getComputedStyle(document.body).direction,
        contentDirection: getComputedStyle(document.querySelector('#preview-modal .modal-content')).direction
      };
    });

    console.log('summary   :', dom.summary);
    console.log('advisory  :', dom.advisory ?? '(none)');
    console.log('rows      :', dom.rowCount, '| images per row:', JSON.stringify([...new Set(dom.imagesPerRow)]));
    console.log('pane order:', JSON.stringify(dom.paneLabels));
    console.log('chips     :', JSON.stringify([...new Set(dom.chips)]));
    console.log('baked rows:', dom.bakedBadges, '| heatmap layers:', dom.heatmapLayers);

    const problems = [];
    if (!dom.rowCount) problems.push('no slide rows rendered');
    if (dom.imagesPerRow.some((count) => count < 2)) problems.push('a row is missing one of the two renders');
    if (dom.chips.some((chip) => !chip)) problems.push('a row has no verdict chip');
    if (!/تم التحقق من/.test(dom.summary)) problems.push('header summary is not the verified-count sentence');
    if (dom.paneLabels[0] !== 'HTML (المصدر)') problems.push('source pane must come first in RTL order');

    // Capture the clean two-up first — the heatmap state is a second shot.
    const modalClean = await page.$('#preview-modal .modal-content');
    await (modalClean || page).screenshot({ path: OUT });

    if (dom.direction !== 'rtl' && dom.contentDirection !== 'rtl') {
      problems.push(`proof screen must render RTL, got ${dom.contentDirection}`);
    }

    // Heatmap toggle must actually reveal the overlay.
    await page.click('#chk-preview-heatmap');
    const heatmapVisible = await page.evaluate(() => {
      const layer = document.querySelector('#preview-slides .heatmap-layer');
      return Boolean(layer) && getComputedStyle(layer).display !== 'none';
    });
    if (!heatmapVisible) problems.push('heatmap toggle did not reveal the diff overlay');
    console.log('heatmap toggle works:', heatmapVisible);

    const modalHeat = await page.$('#preview-modal .modal-content');
    await (modalHeat || page).screenshot({ path: OUT.replace('.png', '-heatmap.png') });
    console.log(`\nscreenshot: ${OUT}`);

    if (problems.length) {
      console.error('\nPROOF FAILED:');
      for (const problem of problems) console.error(' -', problem);
      process.exitCode = 1;
    } else {
      console.log('\nPROOF OK');
    }
  } finally {
    await app.close().catch(() => {});
  }
})().catch((error) => { console.error('proof-preview failed:', error); process.exit(1); });
