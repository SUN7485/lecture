'use strict';

// Deterministic Mission 035 contract tests.  These use the production
// verifyAndExport orchestrator with injected adapters: the test proves its
// bounded self-heal/cache decisions without requiring Electron or PowerPoint.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { verifyAndExport } = require('../src/pptxFidelity');

const TARGET = { width: 1900, height: 1300 };
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLxqwAAAABJRU5ErkJggg==';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SOURCE_HTML = '<!doctype html><html><head><style>.slide { color: #111111; }</style></head><body>' +
  '<section class="slide">Clean slide one</section>' +
  '<section class="slide">Outlined box that must heal</section>' +
  '<section class="slide">Clean slide three</section>' +
  '</body></html>';

function rootNode(index) {
  return {
    id: `s${index}:root`, parentId: null, renderAs: 'slide', order: 0,
    bounds: { x: 0, y: 0, w: 950, h: 650 }, style: {}
  };
}

function textNode(index, pathPart, parentId, text, bounds) {
  return {
    id: `s${index}:${pathPart}`, parentId, renderAs: 'text', order: 2,
    bounds, style: { fontFamily: 'Arial', fontSize: 24, color: '#111111' },
    text, runs: [{ text, style: { fontFamily: 'Arial', fontSize: 24, color: '#111111' } }]
  };
}

function threeSlideScene() {
  const outlinedBox = {
    id: 's1:0', parentId: 's1:root', renderAs: 'shape', order: 1,
    // The initial 2x-target region below maps exactly to this CSS-pixel box.
    bounds: { x: 100, y: 100, w: 400, h: 200 },
    style: { fill: '#d9e8ff', border: { top: { width: 1, color: '#123456' } } }
  };
  return {
    format: 'lve.scene-graph', schemaVersion: 2,
    pageSize: { widthPx: 950, heightPx: 650 }, requiredFonts: [],
    slides: [
      {
        index: 1, expectedDomText: 'Clean slide one',
        nodes: [rootNode(0), textNode(0, '0', 's0:root', 'Clean slide one', { x: 60, y: 60, w: 300, h: 40 })],
        bakeRequests: []
      },
      {
        index: 2, expectedDomText: 'Outlined box that must heal',
        nodes: [
          rootNode(1),
          outlinedBox,
          textNode(1, '0.0', outlinedBox.id, 'Outlined box that must heal', { x: 130, y: 165, w: 320, h: 36 })
        ],
        bakeRequests: []
      },
      {
        index: 3, expectedDomText: 'Clean slide three',
        nodes: [rootNode(2), textNode(2, '0', 's2:root', 'Clean slide three', { x: 60, y: 60, w: 300, h: 40 })],
        bakeRequests: []
      }
    ]
  };
}

function renderSlides(prefix) {
  return {
    ok: true,
    slides: [0, 1, 2].map((index) => ({ index, path: `${prefix}-${index + 1}.png`, domText: `slide ${index + 1}` }))
  };
}

function graphHasBakedOutline(sceneGraph) {
  return sceneGraph?.slides?.[1]?.nodes?.some((node) => node.id === 's1:0' && node.renderAs === 'bake');
}

function makeAdapters(calls, options = {}) {
  const captureBakes = async ({ requests }) => {
    await delay(5);
    calls.captureBakes += 1;
    calls.capturedRequests.push((requests || []).map((request) => request.bakeId));
    if (options.failCapture) throw new Error('intentional self-heal capture failure');
    return {
      ok: true,
      bakes: Object.fromEntries((requests || []).map((request) => [request.bakeId, ONE_PIXEL_PNG])),
      files: {}, captured: (requests || []).length, deduplicated: 0, requested: (requests || []).length
    };
  };
  const adapters = {
    async preflight() {
      calls.preflight += 1;
      return { ok: true, errors: [] };
    },
    async renderHtml({ target }) {
      await delay(20);
      calls.renderHtml += 1;
      assert.deepEqual(target, TARGET);
      return renderSlides('source');
    },
    async renderPptx({ sceneGraph, outputPath }) {
      await delay(4);
      calls.renderPptx += 1;
      calls.renderedGraphs.push(structuredClone(sceneGraph));
      await fs.writeFile(outputPath, `pptx render ${calls.renderPptx}`);
      return { ok: true, filePath: outputPath };
    },
    async renderPowerPoint({ target }) {
      await delay(25);
      calls.renderPowerPoint += 1;
      assert.deepEqual(target, TARGET);
      return renderSlides('powerpoint');
    },
    async compare({ slideIndex }) {
      await delay(15);
      calls.compare += 1;
      calls.comparedSlideIndexes.push(slideIndex);
      // On the original candidate, only slide 2 fails.  Once self-heal bakes
      // its outline shape, all slides compare cleanly.
      if (slideIndex === 1 && !graphHasBakedOutline(calls.renderedGraphs.at(-1))) {
        return {
          ok: false, ssim: 0.7, mismatchPercent: 15,
          errors: [{ code: 'SSIM_BELOW_THRESHOLD', message: 'Outlined box is intentionally missing from the native candidate.' }],
          regions: [{ x: 200, y: 200, width: 800, height: 400, area: 320000 }],
          heatmapPath: 'initial-slide-2-heatmap.png'
        };
      }
      return { ok: true, ssim: 0.99, mismatchPercent: 0.1, regions: [], heatmapPath: `heatmap-${slideIndex + 1}.png` };
    },
    async audit() {
      calls.audit += 1;
      return { ok: true, expectedSlideCount: 3, actualSlideCount: 3, slides: [0, 1, 2].map((index) => ({ index, ok: true })), errors: [] };
    },
    async cleanup() { calls.cleanup += 1; },
    captureBakes
  };
  return { adapters, captureBakes };
}

function freshCalls() {
  return {
    preflight: 0, renderHtml: 0, renderPptx: 0, renderPowerPoint: 0,
    compare: 0, audit: 0, cleanup: 0, captureBakes: 0,
    renderedGraphs: [], comparedSlideIndexes: [], capturedRequests: []
  };
}

async function runExport({ root, sceneGraph, calls, cachePath, cacheBakeDirectory, noCache = false, runName, html = SOURCE_HTML, adapterOptions }) {
  const workDir = path.join(root, `${runName}-work`);
  const destinationPath = path.join(root, `${runName}.pptx`);
  const { adapters, captureBakes } = makeAdapters(calls, adapterOptions);
  return verifyAndExport({
    sceneGraph,
    html,
    themeCss: '.slide { color: #111111; }',
    baseDir: root,
    destinationPath,
    expectedSlideCount: 3,
    sourceWidth: TARGET.width,
    sourceHeight: TARGET.height,
    fidelityPolicy: 'editable-best-effort',
    evidenceMode: 'full',
    workDir,
    cachePath,
    cacheBakeDirectory,
    noCache,
    // Keep both injection points while the self-heal hook is introduced: the
    // test remains an adapter-only test whether the production function reads
    // the hook from options or its adapter collection.
    captureBakes,
    adapters
  });
}

test('self-heal bakes the failed slide without mutating the caller scene graph', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-pptx-self-heal-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = threeSlideScene();
  const snapshot = structuredClone(original);
  const calls = freshCalls();

  const result = await runExport({
    root, sceneGraph: original, calls, runName: 'self-heal',
    cachePath: path.join(root, 'cache.json'),
    cacheBakeDirectory: path.join(root, 'cache-bakes'),
    noCache: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.report.verificationState, 'verified');
  assert.equal(result.report.failedSlideCount, 0);
  assert.deepEqual(result.report.slideVerdicts.map((verdict) => verdict.verdict), ['verified', 'verified', 'verified']);
  assert.equal(result.report.slides[0].healed, null);
  assert.equal(result.report.slides[2].healed, null);

  const healed = result.report.slides[1];
  assert.equal(healed.cached, false);
  assert.ok(healed.healed, 'slide 2 must retain a healing record');
  assert.equal(healed.selfHeal?.initialVerdict, 'failed', 'the report must preserve the original verdict');
  assert.ok(healed.healed.round >= 1 && healed.healed.round <= 2);
  assert.deepEqual(healed.healed.demotedNodeIds, ['s1:0']);
  assert.ok(healed.bakedByHeal >= 1);
  assert.ok(Array.isArray(healed.visualAttempts) && healed.visualAttempts.length >= 2,
    'the report must retain before/after visual attempts');
  assert.equal(result.report.slideVerdicts[1].verdict, 'verified');
  assert.deepEqual(calls.capturedRequests, [['s1:0']]);
  assert.ok(calls.renderedGraphs.some(graphHasBakedOutline), 'the retry must render the demoted outline as a bake');
  const healedGraph = calls.renderedGraphs.find(graphHasBakedOutline);
  assert.equal(healedGraph.slides[1].nodes.some((node) => node.id === 's1:0.0'), false,
    'demoting a parent must remove its native child to prevent duplicate content');
  assert.deepEqual(original, snapshot, 'self-healing may clone a graph, never mutate the caller graph');
  assert.equal(calls.compare, 4, 'three initial compares plus one retry of only the failed slide');
});

test('a failed self-heal attempt keeps the first native candidate exportable in best-effort mode', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-pptx-self-heal-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const original = threeSlideScene();
  const snapshot = structuredClone(original);
  const calls = freshCalls();

  const result = await runExport({
    root, sceneGraph: original, calls, runName: 'fallback', noCache: true,
    cachePath: path.join(root, 'cache.json'),
    cacheBakeDirectory: path.join(root, 'cache-bakes'),
    adapterOptions: { failCapture: true }
  });

  assert.equal(result.ok, true, 'best-effort export must retain the last native candidate');
  assert.equal(result.report.verificationState, 'partial');
  assert.equal(result.report.slideVerdicts[1].verdict, 'failed');
  assert.equal(calls.renderPptx, 1, 'the failed bake must not replace the first candidate');
  assert.equal(calls.renderedGraphs.some(graphHasBakedOutline), false);
  assert.ok(result.report.warnings.some((warning) => warning.code === 'SELF_HEAL_ATTEMPT_FAILED'));
  assert.equal(result.report.slides[1].selfHeal?.attempts?.[0]?.status, 'aborted');
  assert.deepEqual(original, snapshot, 'the failed fallback must not mutate the caller graph');
});

test('an identical second export reuses all per-slide cache evidence and skips visual rendering', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-pptx-self-heal-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'cache.json');
  const cacheBakeDirectory = path.join(root, 'cache-bakes');
  const original = threeSlideScene();
  const snapshot = structuredClone(original);
  const calls = freshCalls();

  const firstStartedAt = performance.now();
  const first = await runExport({ root, sceneGraph: original, calls, cachePath, cacheBakeDirectory, runName: 'cache-first' });
  const firstElapsedMs = performance.now() - firstStartedAt;
  assert.equal(first.ok, true);
  assert.equal(first.report.slides[1].healed?.round >= 1, true);
  assert.ok((await fs.readFile(cachePath, 'utf8')).includes('entries'), 'the first run must persist reusable evidence');
  const afterFirst = {
    renderHtml: calls.renderHtml,
    renderPowerPoint: calls.renderPowerPoint,
    compare: calls.compare,
    captureBakes: calls.captureBakes
  };

  const secondStartedAt = performance.now();
  const second = await runExport({ root, sceneGraph: original, calls, cachePath, cacheBakeDirectory, runName: 'cache-second' });
  const secondElapsedMs = performance.now() - secondStartedAt;
  assert.equal(second.ok, true);
  assert.equal(second.report.verificationState, 'verified');
  assert.equal(second.report.slides.filter((slide) => slide.cached).length, 3,
    'every unchanged slide must say that its verdict came from cache');
  assert.deepEqual(second.report.slideVerdicts.map((verdict) => verdict.verdict), ['verified', 'verified', 'verified']);
  assert.equal(calls.renderHtml, afterFirst.renderHtml, 'all cache hits skip source rendering');
  assert.equal(calls.renderPowerPoint, afterFirst.renderPowerPoint, 'all cache hits skip PowerPoint rendering');
  assert.equal(calls.compare, afterFirst.compare, 'all cache hits skip visual comparison');
  assert.equal(calls.captureBakes, afterFirst.captureBakes, 'cached healed bakes are rehydrated, not recaptured');
  assert.ok(graphHasBakedOutline(calls.renderedGraphs.at(-1)),
    'cached healed demotions must be applied before rebuilding the second PPTX');
  assert.ok(secondElapsedMs < firstElapsedMs * 0.5,
    `all-cache export must complete in under half the first run (${secondElapsedMs.toFixed(1)}ms vs ${firstElapsedMs.toFixed(1)}ms)`);

  const beforePartial = { renderHtml: calls.renderHtml, renderPowerPoint: calls.renderPowerPoint, compare: calls.compare };
  const partial = await runExport({
    root, sceneGraph: original, calls, cachePath, cacheBakeDirectory, runName: 'cache-partial',
    html: SOURCE_HTML.replace('Clean slide three', 'Clean slide three revised')
  });
  assert.deepEqual(partial.report.slides.map((slide) => slide.cached), [true, true, false],
    'a slide-local source edit must leave earlier slide cache entries reusable');
  assert.equal(calls.renderHtml, beforePartial.renderHtml + 1);
  assert.equal(calls.renderPowerPoint, beforePartial.renderPowerPoint + 1,
    'a partial hit still renders one candidate deck through PowerPoint');
  assert.equal(calls.compare, beforePartial.compare + 1,
    'only the changed slide is compared after a partial cache hit');
  assert.deepEqual(original, snapshot, 'cache replay must also leave the caller graph unchanged');
});
