'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const PptxGenJS = require('pptxgenjs');
const { auditPptxStructure } = require('../src/pptxFidelity');

async function writePptx(targetPath, build) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  build(pptx);
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  await fs.writeFile(targetPath, buffer);
}

function richScene(slides) {
  return {
    slides: Array.from({ length: slides }, (_, index) => ({
      id: `slide-${index + 1}`,
      nodes: [
        { type: 'text', text: `شريحة ${index + 1} English` },
        { type: 'shape' },
        { type: 'table' }
      ]
    }))
  };
}

test('PPTX XML audit accepts 26 real slide parts with native text, table, and shape objects', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-pptx-audit-'));
  const pptxPath = path.join(root, 'native-26.pptx');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writePptx(pptxPath, (pptx) => {
    for (let index = 0; index < 26; index += 1) {
      const slide = pptx.addSlide();
      slide.addShape(pptx.ShapeType.rect, { x: 0.2, y: 0.2, w: 0.4, h: 0.4, fill: { color: '413258' }, line: { color: '413258' } });
      slide.addText(`شريحة ${index + 1} English`, { x: 0.8, y: 0.2, w: 4, h: 0.4, fontFace: 'Arial', fontSize: 16, color: '413258' });
      slide.addTable([['A', 'B'], ['1', '2']], { x: 0.8, y: 0.9, w: 3.2, h: 0.8, border: { type: 'solid', color: '413258', pt: 1 } });
    }
  });

  const report = await auditPptxStructure({ pptxPath, sceneGraph: richScene(26), expectedSlideCount: 26 });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.actualSlideCount, 26);
  assert.equal(report.slides.length, 26);
  for (const slide of report.slides) {
    assert.ok(slide.textRunCount > 0);
    assert.ok(slide.tableCount > 0);
    assert.equal(slide.fullSlidePictureCount, 0);
    assert.equal(slide.ok, true);
  }
});

test('PPTX XML audit rejects a full-slide screenshot when the scene requires editable native text', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lve-pptx-audit-'));
  const pptxPath = path.join(root, 'screenshot-only.pptx');
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Tiny transparent PNG; scaling it to the slide is intentional—the audit
  // verifies object semantics, not image aesthetics.
  const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLrWAAAAABJRU5ErkJggg==';
  await writePptx(pptxPath, (pptx) => {
    const slide = pptx.addSlide();
    slide.addImage({ data: onePixelPng, x: 0, y: 0, w: 13.333, h: 7.5 });
  });

  const report = await auditPptxStructure({
    pptxPath,
    sceneGraph: { slides: [{ nodes: [{ type: 'text', text: 'Editable text is required.' }] }] },
    expectedSlideCount: 1
  });
  assert.equal(report.ok, false);
  assert.ok(report.slides[0].fullSlidePictureCount > 0);
  assert.ok(report.errors.some((error) => error.code === 'PPTX_NATIVE_TEXT_MISSING'));
  assert.ok(report.errors.some((error) => error.code === 'PPTX_FULL_SLIDE_SCREENSHOT'));
});
