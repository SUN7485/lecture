'use strict';

// This is deliberately a test double, not a second exporter.  It defines the
// observable contract expected from the production fidelity service while
// keeping unit tests runnable on machines without Office or an OCR engine.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

class FidelityContractFailure extends Error {
  constructor(stage, message, details = {}) {
    super(message);
    this.name = 'FidelityContractFailure';
    this.stage = stage;
    Object.assign(this, details);
  }
}

function reportFor(sceneGraph, sourceWidth, sourceHeight) {
  const slides = Array.isArray(sceneGraph?.slides) ? sceneGraph.slides : [];
  return {
    sourceWidth,
    sourceHeight,
    slideCount: slides.length,
    structural: null,
    slides: slides.map((slide, index) => ({
      slide: index + 1,
      nodeCount: Array.isArray(slide?.nodes) ? slide.nodes.length : 0,
      sourceRender: null,
      powerPointRender: null,
      heatmap: null,
      ocr: null,
      visual: null,
      structural: null,
      failure: null
    }))
  };
}

function asFailure(value, fallbackStage) {
  if (value instanceof FidelityContractFailure) return value;
  if (value instanceof Error) return new FidelityContractFailure(value.stage || fallbackStage, value.message, value);
  if (value && typeof value === 'object') {
    return new FidelityContractFailure(value.stage || fallbackStage, value.error || value.reason || 'Fidelity verification failed.', value);
  }
  return new FidelityContractFailure(fallbackStage, String(value || 'Fidelity verification failed.'));
}

function recordFailure(report, failure) {
  const slideNumber = Number.isInteger(failure.slide) ? failure.slide : 1;
  const slide = report.slides[slideNumber - 1];
  const detail = {
    stage: failure.stage,
    reason: failure.message,
    node: failure.node || null,
    property: failure.property || null
  };
  if (slide) slide.failure = detail;
  return detail;
}

async function expectOk(adapter, argument, fallbackStage) {
  const result = await adapter(argument);
  if (result === false || (result && result.ok === false)) {
    throw asFailure(result, fallbackStage);
  }
  return result || { ok: true };
}

function artifactAt(result, index) {
  if (Array.isArray(result?.slides)) return result.slides[index] || null;
  return index === 0 ? result : null;
}

/**
 * Execute the fidelity contract with injected platform adapters.
 *
 * A real service must retain the selected destination untouched until this
 * function's equivalent has passed every stage.  The candidate lives beside
 * the destination so its final rename is an atomic same-volume replacement.
 */
async function runFidelityContract({
  sceneGraph,
  html = '',
  destinationPath,
  sourceWidth = 1900,
  sourceHeight = 1300,
  adapters
}) {
  if (!destinationPath) throw new TypeError('destinationPath is required');
  if (!adapters) throw new TypeError('adapters are required');

  const report = reportFor(sceneGraph, sourceWidth, sourceHeight);
  const candidatePath = path.join(
    path.dirname(destinationPath),
    `.${path.basename(destinationPath)}.fidelity-${process.pid}-${crypto.randomUUID()}.tmp.pptx`
  );
  let stage = 'preflight';

  try {
    await expectOk(adapters.preflight, { sceneGraph, html, sourceWidth, sourceHeight }, stage);

    stage = 'html-render';
    const htmlRender = await expectOk(adapters.renderHtml, { html, sceneGraph, sourceWidth, sourceHeight }, stage);
    for (let index = 0; index < report.slides.length; index += 1) {
      report.slides[index].sourceRender = artifactAt(htmlRender, index);
    }

    stage = 'pptx-export';
    await expectOk(adapters.renderPptx, { sceneGraph, candidatePath, sourceWidth, sourceHeight }, stage);

    stage = 'powerpoint-render';
    const pptxRender = await expectOk(adapters.renderPowerPoint, { candidatePath, sourceWidth, sourceHeight }, stage);
    for (let index = 0; index < report.slides.length; index += 1) {
      report.slides[index].powerPointRender = artifactAt(pptxRender, index);
    }

    for (let index = 0; index < report.slides.length; index += 1) {
      const slide = sceneGraph.slides[index];
      const row = report.slides[index];

      stage = 'ocr';
      const ocr = await expectOk(adapters.ocr, {
        slide,
        slideIndex: index,
        sourceRender: row.sourceRender,
        powerPointRender: row.powerPointRender
      }, stage);
      row.ocr = ocr;

      stage = 'visual-comparison';
      const visual = await expectOk(adapters.compare, {
        slide,
        slideIndex: index,
        sourceRender: row.sourceRender,
        powerPointRender: row.powerPointRender
      }, stage);
      row.visual = visual;
      row.heatmap = visual.heatmap || null;
    }

    stage = 'pptx-audit';
    const structural = await expectOk(adapters.audit, { candidatePath, sceneGraph }, stage);
    report.structural = structural;
    if (Array.isArray(structural.slides)) {
      structural.slides.forEach((value, index) => {
        if (report.slides[index]) report.slides[index].structural = value;
      });
    }

    stage = 'commit';
    // `rename` replaces an existing path on supported Windows/NTFS and POSIX
    // volumes. The source is in the destination directory by construction.
    await fs.rename(candidatePath, destinationPath);
    return { ok: true, stage: 'verified', report, filePath: destinationPath };
  } catch (error) {
    const failure = asFailure(error, stage);
    recordFailure(report, failure);
    return { ok: false, stage: failure.stage || stage, report, error: failure.message };
  } finally {
    try { await fs.unlink(candidatePath); } catch (_) {}
    if (typeof adapters.cleanup === 'function') {
      try { await adapters.cleanup({ candidatePath, stage }); } catch (_) {}
    }
  }
}

module.exports = { FidelityContractFailure, runFidelityContract };
