'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fssync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { FidelityContractFailure, runFidelityContract } = require('./support/fidelity-contract-harness');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'fidelity');

function makeScene(slideCount = 1) {
  return {
    version: 1,
    slides: Array.from({ length: slideCount }, (_, index) => ({
      id: `slide-${index + 1}`,
      nodes: [{ id: `slide-${index + 1}-text`, type: 'text', text: 'ترتيب RTL 42 English' }]
    }))
  };
}

function artifacts(slideCount) {
  return { ok: true, slides: Array.from({ length: slideCount }, (_, index) => ({ path: `slide-${index + 1}.png` })) };
}

function makeAdapters({ scenario = 'pass', slideCount = 1, calls }) {
  const fail = (stage, message, details) => { throw new FidelityContractFailure(stage, message, details); };
  return {
    async preflight() {
      calls.preflight += 1;
      if (scenario === 'missing-font') fail('preflight', 'Slide 1: required font "Fidelity Missing Font" is not installed.', {
        slide: 1, node: 'slide-1-text', property: 'fontFamily'
      });
      if (scenario === 'unsupported-css') fail('scene-validation', 'Slide 1: unsupported CSS property "filter".', {
        slide: 1, node: 'slide-1-text', property: 'filter'
      });
      return { ok: true };
    },
    async renderHtml({ sourceWidth, sourceHeight }) {
      calls.renderHtml += 1;
      assert.equal(sourceWidth, 1900);
      assert.equal(sourceHeight, 1300);
      return artifacts(slideCount);
    },
    async renderPptx({ candidatePath }) {
      calls.renderPptx += 1;
      await fs.writeFile(candidatePath, 'candidate editable pptx');
      return { ok: true };
    },
    async renderPowerPoint({ sourceWidth, sourceHeight }) {
      calls.renderPowerPoint += 1;
      assert.equal(sourceWidth, 1900);
      assert.equal(sourceHeight, 1300);
      if (scenario === 'renderer-timeout') fail('powerpoint-render', 'PowerPoint renderer timed out after 30000ms.', { slide: 1 });
      return artifacts(slideCount);
    },
    async ocr({ slideIndex }) {
      calls.ocr += 1;
      if (scenario === 'ocr-mismatch') fail('ocr', 'Slide 1: Arabic RTL token order differs at word 2.', {
        slide: slideIndex + 1, node: 'slide-1-text', property: 'rtlTokenOrder'
      });
      return { ok: true, expected: 'ترتيب RTL 42 English', positionsMatch: true, rtlTokenOrderMatch: true };
    },
    async compare({ slideIndex }) {
      calls.compare += 1;
      if (scenario === 'visual-mismatch') fail('visual-comparison', 'Slide 1: SSIM 0.995 < 0.9995; largest difference region 16x16.', {
        slide: slideIndex + 1, property: 'ssim'
      });
      return { ok: true, ssim: 1, pixelMismatch: 0, largestDifferenceRegion: { width: 0, height: 0 }, heatmap: `slide-${slideIndex + 1}-heatmap.png` };
    },
    async audit() {
      calls.audit += 1;
      return {
        ok: true,
        slideParts: slideCount,
        fullSlidePictures: 0,
        slides: Array.from({ length: slideCount }, () => ({ ok: true, nativeText: 1, nativeShapes: 1, nativeTables: 1 }))
      };
    },
    async cleanup() { calls.cleanup += 1; }
  };
}

async function runScenario(scenario, slideCount = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-fidelity-contract-'));
  const destinationPath = path.join(root, 'lecture.pptx');
  const calls = { preflight: 0, renderHtml: 0, renderPptx: 0, renderPowerPoint: 0, ocr: 0, compare: 0, audit: 0, cleanup: 0 };
  await fs.writeFile(destinationPath, 'existing destination must survive failure');
  const result = await runFidelityContract({
    sceneGraph: makeScene(slideCount),
    html: '<section class="slide">fixture</section>',
    destinationPath,
    adapters: makeAdapters({ scenario, slideCount, calls })
  });
  return { root, destinationPath, calls, result };
}

for (const [scenario, expected] of [
  ['missing-font', { stage: 'preflight', property: 'fontFamily' }],
  ['unsupported-css', { stage: 'scene-validation', property: 'filter' }],
  ['ocr-mismatch', { stage: 'ocr', property: 'rtlTokenOrder' }],
  ['visual-mismatch', { stage: 'visual-comparison', property: 'ssim' }],
  ['renderer-timeout', { stage: 'powerpoint-render', property: null }]
]) {
  test(`failure fixture ${scenario} preserves the selected destination and reports the failing slide`, async (t) => {
    const { root, destinationPath, calls, result } = await runScenario(scenario);
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    assert.equal(result.ok, false);
    assert.equal(result.stage, expected.stage);
    assert.equal(await fs.readFile(destinationPath, 'utf8'), 'existing destination must survive failure');
    assert.equal(result.report.slides[0].failure.stage, expected.stage);
    assert.equal(result.report.slides[0].failure.property, expected.property);
    assert.equal(calls.cleanup, 1);
    assert.deepEqual(fssync.readdirSync(root), ['lecture.pptx']);
  });
}

test('a verified 26-slide editable deck commits only after OCR, visual, and native-object audit pass', async (t) => {
  const { root, destinationPath, calls, result } = await runScenario('pass', 26);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'verified');
  assert.equal(result.filePath, destinationPath);
  assert.equal(await fs.readFile(destinationPath, 'utf8'), 'candidate editable pptx');
  assert.equal(result.report.sourceWidth, 1900);
  assert.equal(result.report.sourceHeight, 1300);
  assert.equal(result.report.slides.length, 26);
  assert.equal(result.report.structural.slideParts, 26);
  assert.equal(result.report.structural.fullSlidePictures, 0);
  assert.equal(calls.ocr, 26);
  assert.equal(calls.compare, 26);
  assert.equal(calls.audit, 1);
  assert.equal(calls.cleanup, 1);
});

test('mandatory HTML and audit fixtures retain the requested regression shape', () => {
  const deck = fssync.readFileSync(path.join(ROOT, 'Chp1-Lec1-2.html'), 'utf8');
  const audit = JSON.parse(fssync.readFileSync(path.join(FIXTURE_DIR, 'pptx-audit.json'), 'utf8'));

  assert.equal((deck.match(/<div\s+class="slide(?:\s|\")/g) || []).length, audit.expectedSlideCount);
  assert.match(deck, /class="slide cover-slide"/);
  assert.match(deck, /display:\s*flex/);
  assert.match(deck, /<table>/);
  assert.match(deck, /<strong>/);
  assert.deepEqual(audit.expectedNativeObjectKinds, ['text', 'table', 'shape', 'picture']);
  assert.equal(audit.forbidFullSlidePictures, true);
});

test('failure fixture sources are explicit HTML inputs, not hidden adapter-only cases', () => {
  for (const name of ['missing-font', 'unsupported-css', 'ocr-mismatch', 'visual-mismatch', 'renderer-timeout']) {
    const html = fssync.readFileSync(path.join(FIXTURE_DIR, `${name}.html`), 'utf8');
    assert.match(html, new RegExp(`data-fidelity-fixture="${name}"`));
    assert.match(html, /class="slide"/);
  }
});
