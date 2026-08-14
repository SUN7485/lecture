'use strict';

// DIAGNOSTIC ONLY — not part of the export gate.
//
// OCR was retired from the fidelity gate in mission 034: it demanded exact
// token order, so a single misread killed a correct slide, while the pixel
// diff already catches missing or misplaced text deterministically. The
// bundled ara+eng engine stays useful for answering "what text does PowerPoint
// think is on this slide?" by hand.
//
//   node tools/pptx/diagnose-ocr.js <image.png>

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2];
if (!target || !fs.existsSync(target)) {
  console.error('usage: node tools/pptx/diagnose-ocr.js <image.png>');
  process.exit(2);
}

const { preflightBundledTesseractOcr, runBundledTesseractOcr } =
  require(path.join(__dirname, '..', '..', 'src', 'pptxTesseractOcr.js'));

(async () => {
  const preflight = await preflightBundledTesseractOcr();
  if (!preflight.ok) {
    console.error('bundled OCR unavailable:', preflight.error?.message || 'unknown');
    process.exit(1);
  }
  const result = await runBundledTesseractOcr({ imagePath: path.resolve(target) });
  const words = result.words || result.tokens || [];
  console.log(`# ${path.basename(target)} — ${words.length} words`);
  console.log('text\tleft\ttop\twidth\theight\tconf');
  for (const word of words) {
    console.log([word.text, word.left ?? word.x, word.top ?? word.y,
      word.width ?? word.w, word.height ?? word.h, word.confidence ?? word.conf].join('\t'));
  }
})().catch((error) => { console.error('diagnose-ocr failed:', error.message); process.exit(1); });
