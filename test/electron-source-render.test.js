'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const FIXTURE = path.join(ROOT, 'Chp1-Lec1-2.html');

test('source renderer preserves the cover flex layout and renders all 26 fixture slides at 1900x1300', { timeout: 120000 }, async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-source-render-test-'));
  const { app } = await launchLve({ open: FIXTURE, extraEnv: { LVE_TEST_FIDELITY_HOOK: '1' } });
  try {
    const result = await app.evaluate(async (electron, input) => {
      if (typeof electron.app.__lveTestRenderHtmlSlides !== 'function') {
        throw new Error('The Electron fidelity test hook was not installed.');
      }
      return electron.app.__lveTestRenderHtmlSlides({
        html: input.html,
        baseDir: input.root,
        outputDir: input.outputDir,
        slideSelector: '.slide',
        expectedSlideCount: 26,
        sourceSize: { width: 950, height: 650 },
        target: { width: 1900, height: 1300 }
      });
    }, {
      root: ROOT,
      html: fs.readFileSync(FIXTURE, 'utf8'),
      outputDir: path.join(workDir, 'source')
    });
    const first = result.slides[0];
    assert.equal(result.slides.length, 26);
    assert.equal(first.display, 'flex');
    assert.deepEqual(first.sourceBounds, { width: 950, height: 650 });
    assert.deepEqual(first.renderSize, { width: 1900, height: 1300 });
    assert.equal(fs.existsSync(first.path), true);
    assert.equal(result.slides.every((slide) => fs.existsSync(slide.path)), true);
    assert.equal(result.slides.every((slide) => slide.captureSize?.width === 1900 && slide.captureSize?.height === 1300), true);
    assert.equal(result.slides.every((slide) => slide.renderSize?.width === 1900 && slide.renderSize?.height === 1300), true);
    assert.equal(result.slides.every((slide) => slide.sourceBounds?.width === 950 && slide.sourceBounds?.height === 650), true);
    assert.ok(Math.max(...result.slides.map((slide) => Number(slide.layoutDelta || 0))) < 0.01, 'source scaling reflowed content');
  } finally {
    await app.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
