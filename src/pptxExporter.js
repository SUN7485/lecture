'use strict';

// Kept as an explicit compatibility tripwire for integrations that imported
// the old screenshot exporter. A full-slide PNG is not an editable PPTX and
// must never be substituted when the native fidelity gate cannot pass.
async function exportPptxFromHtml() {
  throw new Error('Slide-image PPTX export has been removed. Use the verified editable scene-graph export.');
}

async function renderSlideScreenshots() {
  throw new Error('Slide-image fallback rendering has been removed from the PPTX export contract.');
}

module.exports = { exportPptxFromHtml, renderSlideScreenshots };
