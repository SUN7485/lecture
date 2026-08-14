'use strict';

// Direct tests for src/pptxFidelity.js.  Platform adapters are mocked so this
// suite is deterministic and does not need Office, a Tesseract binary, or a
// network install.  The production orchestrator—not a parallel test
// implementation—owns stage ordering, report writing, and atomic commit.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { verifyAndExport, collectRequiredFonts, compareOcrResult } = require('../src/pptxFidelity');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'fidelity');

test('main-process export is wired to the fidelity gate and has no pixel-PPTX bypass', async () => {
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const rendererSource = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const fidelitySource = await fs.readFile(path.join(__dirname, '..', 'src', 'pptxFidelity.js'), 'utf8');

  assert.match(mainSource, /require\(['"]\.\/pptxFidelity['"]\)/);
  assert.match(mainSource, /verifyAndExport\s*\(/);
  assert.match(mainSource, /sceneGraph/);
  assert.match(mainSource, /require\(['"]\.\/pptxTesseractOcr['"]\)/);
  assert.match(mainSource, /preflightBundledTesseractOcr\s*\(/);
  assert.match(mainSource, /runBundledTesseractOcr\s*\(/);
  assert.match(mainSource, /pptxToolPath\('ocr'\)/);
  assert.doesNotMatch(mainSource, /ocr-winrt\.ps1/);
  assert.match(mainSource, /preflightVerifiedPptx/);
  assert.doesNotMatch(mainSource, /mode\s*===\s*['"]pixel['"]/);
  assert.doesNotMatch(rendererSource, /pptx-export-mode/);
  assert.match(fidelitySource, /candidateIndex !== index\) candidate\.style\.setProperty\('display', 'none'/);
  assert.doesNotMatch(fidelitySource, /candidateIndex === index \? 'block' : 'none'/);
});

test('font preflight consumes versioned scene-graph font descriptors without stringifying objects', () => {
  const fonts = collectRequiredFonts({
    requiredFonts: [
      { family: 'Diodrum Arabic', weight: '700', style: 'normal' },
      { family: 'Lyon Arabic Text', weight: '400', style: 'normal' }
    ],
    slides: []
  });
  assert.deepEqual(fonts, ['Diodrum Arabic', 'Lyon Arabic Text']);
});

test('OCR comparison treats punctuation attached to OCR word boxes like DOM tokenisation', () => {
  const tokens = [
    { text: 'الأولى:', x: 10, y: 10, w: 50, h: 20 },
    { text: '(Industrial', x: 70, y: 10, w: 80, h: 20 },
    { text: 'Making)', x: 160, y: 10, w: 60, h: 20 }
  ];
  const result = compareOcrResult({
    ok: true,
    source: { tokens },
    powerPoint: { tokens: structuredClone(tokens) }
  }, { expectedDomText: 'الأولى (Industrial Making)' });
  assert.equal(result.ok, true);
  assert.equal(result.expectedDomTextMatch, true);
  assert.equal(result.rtlTokenOrderMatch, true);
  assert.equal(result.wordPositionsMatch, true);
});

function scene(slideCount = 1) {
  return {
    version: 1,
    requiredFonts: ['Cairo'],
    slides: Array.from({ length: slideCount }, (_, index) => ({
      id: `slide-${index + 1}`,
      plainText: `شريحة ${index + 1} RTL ${index + 1} English`,
      nodes: [
        { id: `text-${index + 1}`, type: 'text', text: `شريحة ${index + 1} RTL ${index + 1} English` },
        { id: `shape-${index + 1}`, type: 'shape' },
        { id: `table-${index + 1}`, type: 'table' }
      ]
    }))
  };
}

function failure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function makeAdapters({ scenario, slideCount, calls }) {
  const slides = (prefix) => ({
    ok: true,
    slides: Array.from({ length: slideCount }, (_, index) => ({
      index,
      path: `${prefix}-${index + 1}.png`,
      domText: `شريحة ${index + 1} RTL ${index + 1} English`
    }))
  });

  return {
    async preflight() {
      calls.preflight += 1;
      if (scenario === 'missing-font') {
        return {
          ok: false,
          errors: [{
            code: 'REQUIRED_FONT_MISSING',
            message: 'Slide 1: required font Fidelity Missing Font is not installed.',
            slideIndex: 0,
            node: 'text-1',
            property: 'fontFamily'
          }]
        };
      }
      if (scenario === 'unsupported-css') {
        return {
          ok: false,
          errors: [{
            code: 'UNSUPPORTED_CSS_PROPERTY',
            message: 'Slide 1: CSS filter is unsupported for editable export.',
            slideIndex: 0,
            node: 'text-1',
            property: 'filter'
          }]
        };
      }
      return { ok: true, errors: [] };
    },
    async renderHtml({ target }) {
      calls.renderHtml += 1;
      assert.deepEqual(target, { width: 1900, height: 1300 });
      return slides('source');
    },
    async renderPptx({ outputPath }) {
      calls.renderPptx += 1;
      await fs.writeFile(outputPath, 'temporary editable PPTX');
      return { ok: true, filePath: outputPath };
    },
    async renderPowerPoint({ target }) {
      calls.renderPowerPoint += 1;
      assert.deepEqual(target, { width: 1900, height: 1300 });
      if (scenario === 'renderer-timeout') {
        throw failure('POWERPOINT_RENDER_TIMEOUT', 'Desktop PowerPoint did not render the PPTX within 50ms.', { slideIndex: 0 });
      }
      return slides('powerpoint');
    },
    async ocr({ languages, slideIndex }) {
      calls.ocr += 1;
      assert.deepEqual(languages, ['ara', 'eng']);
      if (scenario === 'ocr-mismatch') {
        return { ok: true, expectedDomTextMatch: true, rtlTokenOrderMatch: false, wordPositionsMatch: false, slideIndex };
      }
      return { ok: true, expectedDomTextMatch: true, rtlTokenOrderMatch: true, wordPositionsMatch: true, slideIndex };
    },
    async compare({ thresholds }) {
      calls.compare += 1;
      assert.equal(thresholds.ssim, 0.9995);
      assert.equal(thresholds.pixelMismatchPercent, 0.02);
      if (scenario === 'visual-mismatch') {
        return { ok: false, errors: [{ code: 'SSIM_BELOW_THRESHOLD', message: 'SSIM 0.9950000 is below 0.9995.' }], heatmapPath: 'heatmap.png' };
      }
      return { ok: true, ssim: 1, mismatchPercent: 0, heatmapPath: 'heatmap.png' };
    },
    async audit() {
      calls.audit += 1;
      return {
        ok: true,
        actualSlideCount: slideCount,
        slides: Array.from({ length: slideCount }, (_, index) => ({ index, ok: true, textRunCount: 1, tableCount: 1, nativeObjectCount: 2, fullSlidePictureCount: 0 }))
      };
    },
    async cleanup() { calls.cleanup += 1; }
  };
}

async function run(scenario, slideCount = 1, fidelityPolicy, evidenceMode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-fidelity-service-test-'));
  const workDir = path.join(root, 'lve-pptx-fidelity-test-work');
  const destinationPath = path.join(root, 'selected-destination.pptx');
  const calls = { preflight: 0, renderHtml: 0, renderPptx: 0, renderPowerPoint: 0, ocr: 0, compare: 0, audit: 0, cleanup: 0 };
  await fs.writeFile(destinationPath, 'pre-existing destination');
  const fixture = await fs.readFile(path.join(FIXTURE_DIR, `${scenario}.html`), 'utf8').catch(() => '<section class="slide">pass</section>');
  const result = await verifyAndExport({
    sceneGraph: scene(slideCount),
    html: fixture,
    destinationPath,
    sourceWidth: 1900,
    sourceHeight: 1300,
    fidelityPolicy,
    evidenceMode,
    workDir,
    adapters: makeAdapters({ scenario, slideCount, calls })
  });
  return { root, workDir, destinationPath, calls, result };
}

for (const [scenario, expected] of [
  ['missing-font', { stage: 'preflight', code: 'REQUIRED_FONT_MISSING', property: 'fontFamily' }],
  ['unsupported-css', { stage: 'preflight', code: 'UNSUPPORTED_CSS_PROPERTY', property: 'filter' }],
  ['ocr-mismatch', { stage: 'ocr', code: 'OCR_RTL_TOKEN_ORDER_MISMATCH', property: null }],
  ['visual-mismatch', { stage: 'visual', code: 'SSIM_BELOW_THRESHOLD', property: null }],
  ['renderer-timeout', { stage: 'powerpoint-render', code: 'POWERPOINT_RENDER_TIMEOUT', property: null }]
]) {
  test(`production fidelity service: ${scenario} blocks export and retains the chosen file`, async (t) => {
    const { root, destinationPath, calls, result } = await run(scenario);
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    assert.equal(result.ok, false);
    assert.equal(result.stage, expected.stage);
    assert.equal(await fs.readFile(destinationPath, 'utf8'), 'pre-existing destination');
    assert.ok(result.reportPath);
    assert.equal(result.report.failures[0].code, expected.code);
    assert.equal(calls.cleanup, 1);
    // Every reject—also preflight and renderer-timeout rejects—must retain a
    // concrete slide row for the report UI, rather than only a global toast.
    assert.equal(result.report.slides.length, 1);
    assert.ok(result.report.slides[0].failures.length > 0);
    if (expected.property) {
      assert.equal(result.report.failures[0].details.property, expected.property);
      assert.equal(result.report.failures[0].details.node, 'text-1');
    }
  });
}

test('production fidelity service performs 26-slide OCR, visual, and native-object checks before atomic replacement', async (t) => {
  const { root, destinationPath, calls, result } = await run('pass', 26);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(result.ok, true);
  assert.equal(result.stage, 'passed');
  assert.equal(result.filePath, destinationPath);
  assert.equal(await fs.readFile(destinationPath, 'utf8'), 'temporary editable PPTX');
  assert.equal(result.report.target.width, 1900);
  assert.equal(result.report.target.height, 1300);
  assert.equal(result.report.slides.length, 26);
  assert.equal(result.report.structural.actualSlideCount, 26);
  assert.equal(calls.ocr, 26);
  assert.equal(calls.compare, 26);
  assert.equal(calls.audit, 1);
  assert.equal(calls.cleanup, 1);
});

for (const scenario of ['ocr-mismatch', 'visual-mismatch']) {
  test(`editable best-effort export retains ${scenario} evidence but commits the native PPTX`, async (t) => {
    const { root, destinationPath, calls, result } = await run(scenario, 1, 'editable-best-effort');
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    assert.equal(result.ok, true);
    assert.equal(result.verified, false);
    assert.equal(result.stage, 'passed-with-warnings');
    assert.equal(result.filePath, destinationPath);
    assert.equal(await fs.readFile(destinationPath, 'utf8'), 'temporary editable PPTX');
    assert.equal(result.report.failures.length, 0);
    assert.ok(result.report.warnings.length > 0);
    assert.ok(result.report.slides[0].warnings.length > 0);
    assert.equal(calls.audit, 1, 'native-object audit remains a hard requirement');
  });
}

test('native best-effort export commits after preflight and native-object audit without waiting for OCR or pixel evidence', async (t) => {
  const { root, destinationPath, calls, result } = await run('pass', 26, 'editable-best-effort', 'native');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.stage, 'passed-with-warnings');
  assert.equal(result.report.evidenceMode, 'native');
  assert.equal(result.filePath, destinationPath);
  assert.equal(await fs.readFile(destinationPath, 'utf8'), 'temporary editable PPTX');
  assert.equal(calls.renderHtml, 0);
  assert.equal(calls.renderPowerPoint, 0);
  assert.equal(calls.ocr, 0);
  assert.equal(calls.compare, 0);
  assert.equal(calls.audit, 1, 'native-object audit remains a hard requirement');
  assert.ok(result.report.warnings.some((warning) => warning.code === 'FIDELITY_EVIDENCE_DEFERRED'));
});
