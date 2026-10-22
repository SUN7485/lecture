'use strict';

// The front door. Every card on the home screen must map to a flow the
// renderer actually knows: the contract lives in two files (data-flow in
// index.html, the FLOWS table in renderer.js) and nothing else would notice
// them drifting apart — a card with an unknown flow is a button that does
// nothing at all, silently.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const EXPECTED_FLOWS = ['pdf-pptx', 'html-edit', 'html-pdf', 'pdf-pdf', 'word'];

test('the home screen offers every flow, and each one is wired', { timeout: 120000 }, async () => {
  const shot = path.join(ROOT, '.fidelity', 'home-screen.png');
  const { app, page } = await launchLve();

  try {
    await page.waitForSelector('#empty-state .home-card', { timeout: 30000 });

    const home = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#empty-state [data-flow]')];
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        flows: cards.map((c) => c.dataset.flow),
        allVisible: cards.every(visible),
        heroCards: document.querySelectorAll('#empty-state .home-card').length,
        heading: document.querySelector('#empty-state h1')?.textContent.trim(),
        // Every card must carry a real label; an icon-only card is unreadable.
        titled: [...document.querySelectorAll('.home-card')].every(
          (c) => (c.querySelector('.hc-title')?.textContent || '').trim().length > 3
        ),
        // The old #btn-open-2 is gone; if renderer.js still bound it, the
        // TypeError would have killed every listener registered after it —
        // so prove a later one survived.
        exportBound: !!document.querySelector('#btn-export-pptx'),
        canvasHidden: document.querySelector('#zoom-wrap').hidden
      };
    });

    assert.deepEqual(home.flows.slice().sort(), EXPECTED_FLOWS.slice().sort(), 'home screen flows drifted');
    assert.equal(home.heroCards, 3, 'expected three hero cards');
    assert.equal(home.allVisible, true, 'a flow control is present but not visible');
    assert.equal(home.titled, true, 'a card has no readable title');
    assert.equal(home.canvasHidden, true, 'the editor canvas should be hidden on the home screen');
    assert.ok(home.heading && home.heading.length > 0, 'the home screen has no heading');

    // The renderer's own table is the other half of the contract.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer.js'), 'utf8');
    const table = src.slice(src.indexOf('const FLOWS'), src.indexOf('const FLOWS') + 900);
    for (const flow of home.flows) {
      assert.ok(table.includes(`'${flow}'`), `card "${flow}" has no entry in the renderer FLOWS table`);
    }

    // No renderer exception may have happened while booting the home screen.
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluate(() => document.title);
    assert.deepEqual(errors, [], `renderer threw: ${errors.join(' | ')}`);

    // Nothing may overflow the stage: an off-screen card is an unusable one,
    // and `1fr` grid tracks silently refuse to shrink below their content.
    const fit = await page.evaluate(() => {
      const stage = document.querySelector('#stage');
      const grid = document.querySelector('.home-grid');
      return {
        overflowX: stage.scrollWidth - stage.clientWidth,
        cols: getComputedStyle(grid).gridTemplateColumns,
        widths: [...document.querySelectorAll('.home-card')].map((c) => Math.round(c.getBoundingClientRect().width))
      };
    });
    assert.equal(fit.overflowX, 0, `home screen overflows the stage by ${fit.overflowX}px (cols: ${fit.cols})`);
    assert.equal(new Set(fit.widths).size, 1, `hero cards are unequal widths: ${fit.widths.join(', ')}`);

    // Copy must WRAP inside its card, not run off the edge. A flex column with
    // align-items:flex-start shrink-wraps children to max-content, which reads
    // as "…then expor" with the rest of the sentence simply gone.
    // scrollWidth vs clientWidth, NOT the element's bounding box: with
    // `white-space: nowrap` the box stays correctly sized and only the TEXT
    // spills, so a getBoundingClientRect() check passes while the card is
    // visibly cut off. That exact false negative happened here.
    const spill = await page.evaluate(() =>
      [...document.querySelectorAll('.home-card .hc-title, .home-card .hc-desc')]
        .map((el) => ({
          text: el.textContent.trim().slice(0, 24),
          over: el.scrollWidth - el.clientWidth,
          wrap: getComputedStyle(el).whiteSpace
        }))
        .filter((x) => x.over > 1)
    );
    assert.deepEqual(spill, [], `card text overflows its card: ${JSON.stringify(spill)}`);

    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
    console.log(
      `home screen OK: ${home.heroCards} hero cards at ${fit.widths[0]}px, ` +
      `flows [${home.flows.join(', ')}], overflow ${fit.overflowX}px\nscreenshot: ${shot}`
    );
  } finally {
    await app.close().catch(() => {});
  }
});

test('picking "PDF → PowerPoint" imports the PDF and points at the PPTX button', { timeout: 180000 }, async () => {
  const LECTURE = process.env.LVE_TEST_PDF || path.join(ROOT, 'test', 'fixtures', 'lecture.pdf');
  assert.equal(fs.existsSync(LECTURE), true, `missing test lecture: ${LECTURE}`);

  const shot = path.join(ROOT, '.fidelity', 'home-flow-proof.png');
  const { app, page } = await launchLve({ extraEnv: { LVE_OPEN_PDF: LECTURE } });

  try {
    await page.waitForSelector('#empty-state [data-flow="pdf-pptx"]', { timeout: 30000 });
    await page.click('[data-flow="pdf-pptx"]');
    await page.waitForFunction(() => !!window.__editor && !!window.__importedPdf, null, { timeout: 120000 });

    const after = await page.evaluate(() => ({
      slides: document.querySelector('#canvas').contentDocument.querySelectorAll('.slide').length,
      homeHidden: document.querySelector('#empty-state').hidden,
      canvasShown: !document.querySelector('#zoom-wrap').hidden,
      // The whole point of the card: the export it promised is now flagged.
      pptxSuggested: document.querySelector('#btn-export-pptx').classList.contains('suggest'),
      pdfSuggested: document.querySelector('#btn-export').classList.contains('suggest')
    }));

    assert.ok(after.slides > 0, 'the card did not import anything');
    assert.equal(after.canvasShown, true, 'the editor canvas never appeared');
    assert.equal(after.pptxSuggested, true, 'the PPTX button was not suggested after choosing PDF → PowerPoint');
    assert.equal(after.pdfSuggested, false, 'the wrong export button was suggested');

    await page.screenshot({ path: shot });
    console.log(`flow OK: card -> ${after.slides} slides -> PPTX button suggested\nscreenshot: ${shot}`);
  } finally {
    await app.close().catch(() => {});
  }
});
