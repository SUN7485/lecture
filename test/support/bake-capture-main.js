'use strict';

// Electron main-process harness for the bake capture, mirroring
// visual-compare-main.js: captureBakes needs a real BrowserWindow + CDP, so it
// cannot run under plain node --test. Prints one JSON line on stdout.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { captureBakes } = require('../../src/pptxFidelity');

const DECK = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0}
  .slide{position:relative;width:950px;height:650px;background:#fff}
</style></head><body>
  <div class="slide">
    <div style="position:absolute;left:0;top:0;width:950px;height:650px"></div>
    <svg style="position:absolute;left:100px;top:60px;width:200px;height:120px" viewBox="0 0 200 120">
      <rect x="0" y="0" width="200" height="120" fill="#1AD9C7"></rect>
    </svg>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lve-bake-test-'));
  try {
    const result = await captureBakes({
      html: DECK,
      baseDir: '',
      sourceSize: { width: 950, height: 650 },
      target: { width: 1900, height: 1300 },
      // The svg is the slide's second child, so its scene path is "1".
      requests: [{ bakeId: 's0:1', bounds: { x: 100, y: 60, w: 200, h: 120 } }],
      workDir,
      outputDir: path.join(workDir, 'bakes')
    });
    const filePath = result.files['s0:1'];
    const bytes = filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    // PNG signature + IHDR width/height, read straight from the file.
    const isPng = Boolean(bytes) && bytes.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    process.stdout.write(JSON.stringify({
      captured: result.captured,
      requested: result.requested,
      hasDataUrl: String(result.bakes['s0:1'] || '').startsWith('data:image/png;base64,'),
      fileExists: Boolean(bytes),
      isPng,
      width: isPng ? bytes.readUInt32BE(16) : 0,
      height: isPng ? bytes.readUInt32BE(20) : 0
    }));
    app.exit(0);
  } catch (error) {
    process.stderr.write(String(error && error.stack || error));
    app.exit(1);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});
