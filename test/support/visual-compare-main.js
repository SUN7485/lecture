'use strict';

// Runs inside Electron's main process so pptxFidelity's nativeImage-backed
// heatmap encoder is tested with the same API that production uses.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const { compareSlideVisual } = require('../../src/pptxFidelity');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-visual-compare-'));
  try {
    const width = 4;
    const height = 4;
    const sourceBitmap = Buffer.alloc(width * height * 4, 255);
    const powerPointBitmap = Buffer.from(sourceBitmap);
    powerPointBitmap[0] = 0;
    const sourcePath = path.join(root, 'source.png');
    const powerPointPath = path.join(root, 'powerpoint.png');
    const heatmapPath = path.join(root, 'heatmap.png');
    fs.writeFileSync(sourcePath, nativeImage.createFromBitmap(sourceBitmap, { width, height, scaleFactor: 1 }).toPNG());
    fs.writeFileSync(powerPointPath, nativeImage.createFromBitmap(powerPointBitmap, { width, height, scaleFactor: 1 }).toPNG());
    const result = await compareSlideVisual({ sourcePath, powerPointPath, heatmapPath });
    process.stdout.write(JSON.stringify({
      heatmapExists: fs.existsSync(heatmapPath),
      mismatchPixels: result.mismatchPixels,
      errors: result.errors?.map((error) => error.code) || []
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

app.whenReady().then(main).then(
  () => app.quit(),
  (error) => { console.error(error.stack || error); process.exitCode = 1; app.quit(); }
);
