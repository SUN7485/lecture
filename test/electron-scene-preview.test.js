'use strict';

// This is deliberately a real Electron/Chromium test rather than a DOM mock:
// the scene graph is browser-measured and the preview overlay must accept
// ordinary pointer input. It does not invoke a PPTX export, so it remains
// deterministic on machines intentionally blocked by a missing fidelity font.
const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { ROOT, launchLve } = require('./support/launch-electron');

const FIXTURE = path.join(ROOT, 'Chp1-Lec1-2.html');

async function launchFixture() {
  const { app, page } = await launchLve({ open: FIXTURE });
  await page.waitForFunction(() =>
    window.__editor && window.__editor.doc && window.__editor.doc.querySelectorAll('.slide').length === 26,
  null, { timeout: 60000 });
  return { app, page };
}

test('mandatory 26-slide fixture extracts a complete browser-measured scene graph', { timeout: 90000 }, async () => {
  const { app, page } = await launchFixture();
  try {
    const scene = await page.evaluate(() => {
      const editor = window.__editor;
      const graph = editor.serializeForPptx();
      const normalise = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const expectedMismatches = graph.slides
        .map((slide, index) => ({ index, expected: slide.expectedDomText, actual: normalise(editor.slides()[index].innerText || editor.slides()[index].textContent) }))
        .filter((item) => item.expected !== item.actual);
      const allNodes = graph.slides.flatMap((slide) => slide.nodes);
      return {
        format: graph.format,
        schemaVersion: graph.schemaVersion,
        pageSize: graph.pageSize,
        errors: graph.errors,
        slideCount: graph.slides.length,
        expectedMismatches,
        requiredFamilies: graph.requiredFonts.map((font) => font.family),
        coverTextNodes: graph.slides[0].nodes.filter((node) => node.text && node.text.trim()).length,
        richRtlRunCount: allNodes.flatMap((node) => node.runs || [])
          .filter((run) => run.text && run.text.trim() && run.style?.direction === 'rtl').length,
        richRunNewlines: allNodes.flatMap((node) => node.runs || [])
          .filter((run) => /[\r\n]/.test(run.text || '')).length,
        nativeKinds: allNodes.reduce((counts, node) => {
          counts[node.renderAs] = (counts[node.renderAs] || 0) + 1;
          return counts;
        }, {})
      };
    });

    assert.equal(scene.format, 'lve.scene-graph');
    assert.equal(scene.schemaVersion, 2);
    assert.deepEqual(scene.pageSize, { widthPx: 950, heightPx: 650 });
    assert.equal(scene.slideCount, 26);
    assert.deepEqual(scene.errors, []);
    assert.deepEqual(scene.expectedMismatches, []);
    assert.ok(scene.requiredFamilies.includes('Diodrum Arabic'));
    assert.ok(scene.requiredFamilies.includes('Lyon Arabic Text LF Bold'));
    assert.ok(scene.requiredFamilies.includes('Lyon Arabic Text LF RgNo2'));
    assert.equal(scene.requiredFamilies.includes('Diodrum Arabic Regular'), false);
    assert.equal(scene.requiredFamilies.includes('Lyon Arabic Regular'), false);
    // The nested cover has five distinct visual text elements; this guards
    // against regressing to the old h1/h2/content-only extraction.
    assert.ok(scene.coverTextNodes >= 5, `captured ${scene.coverTextNodes} cover text nodes`);
    assert.ok(scene.richRtlRunCount > 0, 'expected rich RTL text runs');
    assert.equal(scene.richRunNewlines, 0, 'layout indentation must not become PowerPoint paragraphs');
    assert.ok(scene.nativeKinds.table >= 2, 'expected both native tables');
    assert.ok(scene.nativeKinds.image >= 1, 'expected the fixture image');
    assert.ok(scene.nativeKinds.list >= 1, 'expected the fixture list');
  } finally {
    await app.close();
  }
});

// Scene v2's central promise: no feature may refuse a deck. An element with no
// native PowerPoint equivalent becomes a picture of itself at its exact bounds.
test('scene v2 bakes an inline SVG instead of refusing the deck', { timeout: 90000 }, async () => {
  const { app, page } = await launchFixture();
  try {
    const scene = await page.evaluate(() => {
      const doc = window.__editor.doc;
      const slide = doc.querySelector('.slide');
      // tagName for a foreign-namespace element is the authored lowercase
      // 'svg'; matching it uppercased is what makes this bake at all.
      slide.insertAdjacentHTML('beforeend',
        '<svg style="position:absolute;left:40px;top:40px;width:120px;height:80px" viewBox="0 0 120 80">' +
        '<rect x="0" y="0" width="120" height="80" fill="#413258"></rect></svg>');
      const graph = window.__editor.serializeForPptx();
      const nodes = graph.slides.flatMap((item) => item.nodes);
      const baked = nodes.filter((node) => node.renderAs === 'bake');
      const requests = graph.slides.flatMap((item) => item.bakeRequests || []);
      return {
        errors: graph.errors,
        bakeCount: graph.bakeCount,
        bakedTags: baked.map((node) => node.tag),
        bakeReasons: baked.flatMap((node) => (node.bake?.reasons || []).map((reason) => reason.property)),
        bakeIds: baked.map((node) => node.id),
        requestIds: requests.map((request) => request.bakeId),
        requestBounds: requests.map((request) => request.bounds),
        bakedHasNoText: baked.every((node) => !node.text && !node.runs.length && !node.textLines),
        svgChildrenLeaked: nodes.filter((node) => node.tag === 'rect').length
      };
    });

    assert.deepEqual(scene.errors, [], 'an unmappable element must never become a scene error');
    assert.equal(scene.bakeCount, 1);
    assert.deepEqual(scene.bakedTags, ['svg']);
    assert.deepEqual(scene.bakeReasons, ['tagName']);
    assert.deepEqual(scene.requestIds, scene.bakeIds, 'every baked node must emit a capture request');
    assert.equal(scene.bakedHasNoText, true, 'a baked node carries no text — the picture already has it');
    assert.equal(scene.svgChildrenLeaked, 0, 'the walk must stop at a baked node');
    const [bounds] = scene.requestBounds;
    assert.ok(bounds.w > 0 && bounds.h > 0, 'a capture request needs measurable bounds');
  } finally {
    await app.close();
  }
});

test('scene v1 records Chromium line fragments and native Office font faces', { timeout: 90000 }, async () => {
  const { app, page } = await launchFixture();
  try {
    const scene = await page.evaluate(() => {
      const editor = window.__editor;
      const doc = editor.doc;
      let theme = doc.getElementById('ve-theme');
      if (!theme) {
        theme = doc.createElement('style');
        theme.id = 've-theme';
        doc.head.appendChild(theme);
      }
      // This is the same alias map written by the bundled theme kit: the CSS
      // name can differ from the actual desktop OTF family.
      theme.dataset.veFonts = JSON.stringify({
        'Diodrum Arabic Regular': 'Diodrum Arabic',
        'Lyon Arabic Regular': 'Lyon Arabic Text'
      });
      const custom = doc.createElement('div');
      custom.textContent = 'Custom preflight face';
      custom.style.cssText = 'position:absolute;left:20px;top:20px;font-family:"Customer Test Face";font-size:16px;';
      doc.querySelector('.slide').appendChild(custom);

      const graph = editor.serializeForPptx();
      const normalise = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const textNodes = graph.slides.flatMap((slide) => slide.nodes.filter((node) => node.text));
      const lines = textNodes.flatMap((node) => node.textLines || []);
      const title = textNodes.find((node) => node.text.includes('Industrial Data Analysis'));
      const diodrum = textNodes.find((node) => node.text.includes('مدرسة الموهوبين'));
      const customNode = textNodes.find((node) => node.text === 'Custom preflight face');
      const richLine = lines.find((line) => new Set((line.runs || []).map((run) => run.style.fontWeight)).size > 1);
      const badGeometry = lines.flatMap((line) => [line.bounds, ...(line.runs || []).map((run) => run.bounds)])
        .filter((box) => !box || !Number.isFinite(box.x) || !Number.isFinite(box.y) ||
          !Number.isFinite(box.w) || !Number.isFinite(box.h) || box.w <= 0 || box.h <= 0);
      const invalidLines = lines.filter((line) => !line.text || !line.text.trim() ||
        /[\r\n]/.test(line.text) || !line.runs.length ||
        line.runs.some((run) => !run.text || !run.text.trim() || /[\r\n]/.test(run.text) ||
          normalise(line.runs.map((item) => item.text).join('')) !== normalise(line.text)));
      const textMismatches = textNodes.filter((node) =>
        normalise((node.textLines || []).map((line) => line.runs.map((run) => run.text).join('')).join(' ')) !==
        normalise(node.text));
      return {
        textNodeCount: textNodes.length,
        lineCount: lines.length,
        layoutsValid: textNodes.every((node) => node.textLineCoordinateSpace === 'slide' && Array.isArray(node.textLines) &&
          node.textLines.every((line) => line.coordinateSpace === 'slide')),
        badGeometryCount: badGeometry.length,
        invalidLineCount: invalidLines.length,
        textMismatchCount: textMismatches.length,
        title: title && {
          lineCount: title.textLines.length,
          style: title.style,
          runStyle: title.textLines[0].runs[0].style
        },
        diodrum: diodrum && diodrum.style,
        richLine: richLine && richLine.runs.map((run) => ({ direction: run.direction, style: run.style })),
        custom: customNode && customNode.style,
        requiredFonts: graph.requiredFonts,
        requiredFamilies: graph.requiredFonts.map((font) => font.family)
      };
    });

    assert.equal(scene.layoutsValid, true);
    assert.ok(scene.lineCount > scene.textNodeCount, 'fixture must contain wrapped visual text lines');
    assert.equal(scene.badGeometryCount, 0, 'all line and inline-run bounds must be measurable slide-local rectangles');
    assert.equal(scene.invalidLineCount, 0, 'line layout must not emit empty or newline-only fragments');
    assert.equal(scene.textMismatchCount, 0, 'measured textLines must reconstruct the node text used for strict renderer validation');
    assert.ok(scene.title.lineCount >= 2, 'the mixed Arabic/English cover title must retain Chromium line breaks');
    assert.equal(scene.title.style.fontFamily, 'Lyon Arabic Regular');
    assert.equal(scene.title.style.resolvedFontFamily, 'Lyon Arabic Text');
    assert.equal(scene.title.style.powerPointFontFamily, 'Lyon Arabic Text LF Bold');
    assert.equal(scene.title.style.powerPointFaceHasIntrinsicWeight, true);
    assert.equal(scene.title.runStyle.powerPointFontFamily, 'Lyon Arabic Text LF Bold');
    assert.equal(scene.diodrum.powerPointFontFamily, 'Diodrum Arabic');
    assert.equal(scene.diodrum.powerPointFaceHasIntrinsicWeight, false);
    assert.ok(scene.richLine.every((run) => run.direction === 'rtl'), 'inline visual runs retain RTL direction');
    assert.ok(scene.richLine.some((run) => run.style.fontWeight === '700'), 'inline rich styles retain bold weight');
    assert.equal(scene.custom.fontFamily, 'Customer Test Face');
    assert.equal(scene.custom.resolvedFontFamily, 'Customer Test Face');
    assert.equal(scene.custom.powerPointFontFamily, 'Customer Test Face', 'unknown custom faces must not be substituted');
    assert.ok(scene.requiredFamilies.includes('Diodrum Arabic'));
    assert.ok(scene.requiredFamilies.includes('Lyon Arabic Text LF Bold'));
    assert.ok(scene.requiredFamilies.includes('Lyon Arabic Text LF RgNo2'));
    assert.ok(scene.requiredFamilies.includes('Customer Test Face'));
    assert.deepEqual(scene.requiredFonts.find((font) => font.family === 'Lyon Arabic Text LF Bold'), {
      family: 'Lyon Arabic Text LF Bold',
      weight: '700',
      style: 'normal',
      browserFamily: 'Lyon Arabic Regular',
      resolvedFontFamily: 'Lyon Arabic Text',
      powerPointFontFamily: 'Lyon Arabic Text LF Bold',
      powerPointFaceHasIntrinsicWeight: true
    });
    assert.equal(scene.requiredFamilies.includes('Diodrum Arabic Regular'), false);
    assert.equal(scene.requiredFamilies.includes('Lyon Arabic Regular'), false);
  } finally {
    await app.close();
  }
});

test('preview modal uses normal clicks for its card, controls, outside close, and restored toolbar', { timeout: 90000 }, async () => {
  const { app, page } = await launchFixture();
  try {
    await page.evaluate(() => {
      const modal = document.getElementById('preview-modal');
      const cards = document.getElementById('preview-slides');
      cards.innerHTML = '<button class="preview-slide" type="button">Rendered slide card</button>';
      modal.hidden = false;
      window.__previewClickProbe = { export: 0, toolbar: 0 };
      // Capture these test-only buttons before the real export handlers so
      // ordinary clicks exercise hit testing without starting an Office run.
      document.getElementById('btn-preview-export').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.__previewClickProbe.export += 1;
      }, true);
      document.getElementById('btn-preview-pptx').addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.__previewClickProbe.toolbar += 1;
      }, true);
    });

    await page.click('#preview-slides .preview-slide');
    assert.equal(await page.evaluate(() => document.getElementById('preview-modal').hidden), false);

    await page.click('#btn-preview-export');
    assert.equal(await page.evaluate(() => window.__previewClickProbe.export), 1);

    await page.click('#btn-preview-close');
    await page.waitForFunction(() => document.getElementById('preview-modal').hidden, null, { timeout: 10000 });

    await page.click('#btn-preview-pptx');
    assert.equal(await page.evaluate(() => window.__previewClickProbe.toolbar), 1);

    await page.evaluate(() => { document.getElementById('preview-modal').hidden = false; });
    await page.mouse.click(2, 2);
    await page.waitForFunction(() => document.getElementById('preview-modal').hidden, null, { timeout: 10000 });
  } finally {
    await app.close();
  }
});
