const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const ai = require('./enrich/ai');
const { verifyAndExport, preflightDesktopPowerPoint, renderHtmlSlides } = require('./pptxFidelity');
const { preflightBundledTesseractOcr, runBundledTesseractOcr } = require('./pptxTesseractOcr');

let mainWindow;

if (process.env.LVE_TEST_FIDELITY_HOOK === '1') {
  app.__lveTestRenderHtmlSlides = renderHtmlSlides;
}

// Remember the last lecture opened so we can offer to reopen it next launch.
function lastFilePath() { return path.join(app.getPath('userData'), 'last-file.json'); }
function rememberFile(filePath) {
  try { fs.writeFileSync(lastFilePath(), JSON.stringify({ filePath }), 'utf8'); } catch (_) {}
}
function readLastFile() {
  try {
    const { filePath } = JSON.parse(fs.readFileSync(lastFilePath(), 'utf8'));
    if (filePath && fs.existsSync(filePath)) return filePath;
  } catch (_) {}
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Lecture Visual Editor',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allows the srcdoc iframe (same-origin) editing to work smoothly.
      webSecurity: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  // Electron denies window.open() popups by default; Present mode's speaker
  // view (present.js) needs its named popup allowed through.
  mainWindow.webContents.setWindowOpenHandler(({ frameName }) =>
    frameName === 'lve-speaker' ? { action: 'allow' } : { action: 'deny' });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- File open ----
ipcMain.handle('open-html', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open lecture HTML',
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf8');
  rememberFile(filePath);
  return { filePath, dir: path.dirname(filePath), content };
});

// ---- Word import (010B): pick a .docx, hand its bytes to the renderer ----
// (renderer converts with the same vendored mammoth the web port uses).
ipcMain.handle('open-docx', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Word document',
    filters: [{ name: 'Word', extensions: ['docx'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  return { filePath, base64: fs.readFileSync(filePath).toString('base64') };
});

// ---- Reopen the last lecture (offered on the empty screen) ----
ipcMain.handle('get-last-file', () => {
  const filePath = readLastFile();
  if (!filePath) return null;
  return { filePath, dir: path.dirname(filePath), content: fs.readFileSync(filePath, 'utf8') };
});

// ---- Auto-open (tests / reopen-last-file) ----
ipcMain.handle('auto-open', () => {
  const p = process.env.LVE_OPEN;
  if (!p || !fs.existsSync(p)) return null;
  rememberFile(p);
  return { filePath: p, dir: path.dirname(p), content: fs.readFileSync(p, 'utf8') };
});

// ---- Import another lecture (its slides get merged into the open one) ----
ipcMain.handle('import-html', async () => {
  let filePath = process.env.LVE_IMPORT; // test hook: skip the dialog
  if (!filePath || !fs.existsSync(filePath)) {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import slides from another lecture',
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return null;
    filePath = res.filePaths[0];
  }
  return { filePath, dir: path.dirname(filePath), content: fs.readFileSync(filePath, 'utf8') };
});

// ---- Brand fonts (read once, base64 for data: URLs in the injected theme) ----
// Lives in src/fonts so electron-builder's "src/**/*" rule packages it; fs can
// read it even from inside the asar archive in the packaged app.
let _fontsCache = null;
ipcMain.handle('get-fonts', () => {
  if (_fontsCache) return _fontsCache;
  const dir = path.join(__dirname, 'fonts');
  let out = [];
  try {
    out = fs.readdirSync(dir)
      .filter(f => /\.otf$/i.test(f))
      .map(f => ({
        name: f.replace(/\.otf$/i, ''),
        b64: fs.readFileSync(path.join(dir, f)).toString('base64')
      }));
  } catch (_) {}
  _fontsCache = out;
  return out;
});

// ---- Pick images for the asset panel ----
ipcMain.handle('pick-images', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add images to library',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths.map(p => ({
    path: p,
    name: path.basename(p),
    url: 'file:///' + p.replace(/\\/g, '/')
  }));
});

// ---- Save edited HTML ----
ipcMain.handle('save-html', async (_e, { html, suggestedName }) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save edited HTML',
    defaultPath: suggestedName || 'lecture-edited.html',
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, html, 'utf8');
  return { ok: true, filePath: res.filePath };
});

// ---- Generic text file save/open (theme files, etc.) — anchor-click blob
// downloads don't reliably reach disk from an Electron renderer, so this
// mirrors save-html's native dialog for any text content + extension. ----
ipcMain.handle('save-text-file', async (_e, { content, suggestedName, extension, filterName }) => {
  const ext = extension || 'txt';
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Save file',
    defaultPath: suggestedName || ('file.' + ext),
    filters: [{ name: filterName || ext.toUpperCase(), extensions: [ext] }]
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, content, 'utf8');
  return { ok: true, filePath: res.filePath };
});
ipcMain.handle('open-text-file', async (_e, { extension, filterName }) => {
  const ext = extension || 'txt';
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open file',
    filters: [{ name: filterName || ext.toUpperCase(), extensions: [ext] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  return { filePath, content: fs.readFileSync(filePath, 'utf8') };
});

// ---- AI enrichment (main process holds the API keys) ----
ipcMain.handle('ai-status', () => {
  try { return ai.status(); } catch (e) { return { text: false, image: false, error: String(e) }; }
});
ipcMain.handle('ai-reload-config', () => {
  try { ai.reloadConfig(); return ai.status(); } catch (e) { return { text: false, image: false, error: String(e) }; }
});
ipcMain.handle('ai-chat', (_e, payload) => ai.chat(payload || {}));
ipcMain.handle('ai-image', (_e, payload) => ai.generateImage(payload || {}));

// ---- Settings (API keys) edited from the frontend ----
ipcMain.handle('settings-get', () => {
  try { return ai.getSettings(); } catch (e) { return { error: String(e) }; }
});
ipcMain.handle('settings-save', (_e, next) => {
  try { return ai.writeConfig(next || {}); } catch (e) { return { ok: false, error: String(e) }; }
});

// ---- Brand kits: upload fonts + palette, saved in userData for reuse ----
ipcMain.handle('pick-fonts', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Add font files',
    filters: [{ name: 'Fonts', extensions: ['otf', 'ttf', 'woff', 'woff2'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths.map(p => {
    const ext = path.extname(p).replace('.', '').toLowerCase();
    const base = path.basename(p, path.extname(p));
    // Guess a family + weight from the filename (user can override in the UI).
    const weight = /thin/i.test(base) ? 100 : /extralight|ultralight/i.test(base) ? 200
      : /light/i.test(base) ? 300 : /medium/i.test(base) ? 500 : /semibold|demibold/i.test(base) ? 600
      : /black|heavy/i.test(base) ? 900 : /bold/i.test(base) ? 700 : 400;
    const style = /italic|oblique/i.test(base) ? 'italic' : 'normal';
    const family = base.replace(/[-_](thin|extralight|ultralight|light|regular|medium|semibold|demibold|bold|black|heavy|italic|oblique)/ig, '')
      .replace(/[-_]+/g, ' ').trim() || base;
    return { fileName: path.basename(p), family, weight, style, ext, b64: fs.readFileSync(p).toString('base64') };
  });
});

function brandKitsPath() { return path.join(app.getPath('userData'), 'brand-kits.json'); }
ipcMain.handle('brandkits-get', () => {
  try { return JSON.parse(fs.readFileSync(brandKitsPath(), 'utf8')); } catch (_) { return { kits: [] }; }
});
ipcMain.handle('brandkits-save', (_e, kit) => {
  try {
    let store = { kits: [] };
    try { store = JSON.parse(fs.readFileSync(brandKitsPath(), 'utf8')); } catch (_) {}
    if (!Array.isArray(store.kits)) store.kits = [];
    const i = store.kits.findIndex(k => k.name === kit.name);
    if (i >= 0) store.kits[i] = kit; else store.kits.push(kit);
    fs.writeFileSync(brandKitsPath(), JSON.stringify(store), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});
ipcMain.handle('brandkits-delete', (_e, name) => {
  try {
    let store = { kits: [] };
    try { store = JSON.parse(fs.readFileSync(brandKitsPath(), 'utf8')); } catch (_) {}
    store.kits = (store.kits || []).filter(k => k.name !== name);
    fs.writeFileSync(brandKitsPath(), JSON.stringify(store), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
});

// ---- Per-lecture enrichment cache: <lecture>.enrich.json next to the file ----
function enrichCachePath(lecturePath) {
  if (!lecturePath) return null;
  return lecturePath.replace(/\.html?$/i, '') + '.enrich.json';
}
ipcMain.handle('enrich-cache-read', (_e, { lecturePath } = {}) => {
  try {
    const p = enrichCachePath(lecturePath);
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return null;
});
ipcMain.handle('enrich-cache-write', (_e, { lecturePath, data } = {}) => {
  try {
    const p = enrichCachePath(lecturePath);
    if (!p) return { ok: false };
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: String(e) }; }
});

// ---- PDF rendering (shared by export + preview): clean render in a hidden window ----
async function renderPdfBuffer(html, pageSize) {
  // Write the clean HTML to a temp file so relative assets (base href) resolve.
  const tmp = path.join(os.tmpdir(), `lve-export-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, 'utf8');
  const pdfWin = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: false }
  });
  try {
    await pdfWin.loadFile(tmp);
    // Wait for web fonts and every image to finish loading (8s safety cap).
    await Promise.race([
      pdfWin.webContents.executeJavaScript(`(async () => {
        try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
        await Promise.all(Array.from(document.images).map(im =>
          im.complete ? null : new Promise(res => { im.onload = im.onerror = res; })));
        await new Promise(r => setTimeout(r, 200));
        return true;
      })()`, true),
      new Promise(r => setTimeout(r, 8000))
    ]);
    const opts = { printBackground: true, preferCSSPageSize: true };
    if (pageSize) {
      // Slide deck: page size exactly matches the slide (px -> inches @96dpi).
      opts.pageSize = { width: pageSize.widthPx / 96, height: pageSize.heightPx / 96 };
      opts.margins = { top: 0, bottom: 0, left: 0, right: 0 };
    } else {
      opts.margins = { marginType: 'default' };
    }
    return await pdfWin.webContents.printToPDF(opts);
  } finally {
    pdfWin.destroy();
    fs.unlink(tmp, () => {});
  }
}

// ---- Export PDF ----
ipcMain.handle('export-pdf', async (_e, { html, suggestedName, pageSize }) => {
  let filePath = process.env.LVE_EXPORT_PATH; // test hook: skip the dialog
  if (!filePath) {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export PDF',
      defaultPath: suggestedName || 'lecture.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false };
    filePath = res.filePath;
  }
  try {
    const data = await renderPdfBuffer(html, pageSize);
    fs.writeFileSync(filePath, data);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---- Export PPTX ----
// The Python renderer creates PowerPoint objects (text boxes, tables, lines,
// and pictures) from the editor's structured slide plan.  Do not replace this
// with a BrowserWindow screenshot: a screenshot in a .pptx is not editable.
function nativePptxRendererPath() {
  const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  return path.join(appRoot, 'tools', 'pptx', 'renderer.py');
}

function pptxToolPath(name) {
  const appRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  return path.join(appRoot, 'tools', 'pptx', name);
}

function renderNativePptx(payload, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const rendererPath = nativePptxRendererPath();
    if (!fs.existsSync(rendererPath)) {
      reject(new Error('Native PPTX renderer is missing: ' + rendererPath));
      return;
    }
    const python = process.platform === 'win32' ? 'py' : 'python3';
    let child;
    try {
      child = spawn(python, ['-X', 'utf8', rendererPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error('Could not start Python for PPTX export: ' + error.message));
      return;
    }
    let stdout = '';
    let stderr = '';
    let finished = false;
    const settle = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      settle(() => reject(new Error(`Native PPTX renderer timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => settle(() => reject(new Error('Could not start Python for PPTX export: ' + err.message))));
    child.on('close', (code) => settle(() => {
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const result = JSON.parse(lines[lines.length - 1] || '{}');
        if (code !== 0 || !result.ok) {
          const error = new Error(result.error || stderr || `Native PPTX renderer exited with code ${code}`);
          error.stage = result.stage || 'scene-render';
          error.details = result.errors || result;
          throw error;
        }
        resolve({ ok: true, filePath: result.path, count: (payload.sceneGraph?.slides || []).length });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

// Preview the exact temporary PPTX through PowerPoint — never the source HTML.
function runBundledOcr({ sourcePath, powerPointPath, languages }) {
  return runBundledTesseractOcr({
    bundleRoot: pptxToolPath('ocr'),
    sourcePath,
    powerPointPath,
    languages
  });
}

async function preflightBundledOcr() {
  try {
    const result = await preflightBundledTesseractOcr({
      bundleRoot: pptxToolPath('ocr'),
      timeoutMs: 30000
    });
    return { ...result, stage: 'preflight' };
  } catch (error) {
    return {
      ok: false,
      stage: 'preflight',
      provider: 'Bundled Tesseract',
      error: {
        code: error.code || 'BUNDLED_OCR_PREFLIGHT_FAILED',
        message: error.message || String(error),
        details: error.details
      }
    };
  }
}

function preflightNativePptxRuntime(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const rendererPath = nativePptxRendererPath();
    if (!fs.existsSync(rendererPath)) {
      resolve({
        ok: false,
        error: {
          code: 'NATIVE_PPTX_RENDERER_MISSING',
          message: 'The bundled native editable-PPTX renderer is missing.',
          details: { rendererPath }
        }
      });
      return;
    }
    const python = process.platform === 'win32' ? 'py' : 'python3';
    let child;
    try {
      child = spawn(python, ['-X', 'utf8', '-c', 'import pptx, lxml; print("lve-pptx-runtime-ok")'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (cause) {
      resolve({
        ok: false,
        error: {
          code: 'PYTHON_RUNTIME_MISSING',
          message: 'Python with the editable-PPTX renderer dependencies is required.',
          details: { command: python, cause: cause.message }
        }
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
      settle({
        ok: false,
        error: {
          code: 'PPTX_RUNTIME_PREFLIGHT_TIMEOUT',
          message: `The editable-PPTX runtime did not respond within ${timeoutMs}ms.`,
          details: { command: python, timeoutMs, stdout, stderr }
        }
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (cause) => settle({
      ok: false,
      error: {
        code: 'PYTHON_RUNTIME_MISSING',
        message: 'Python with the editable-PPTX renderer dependencies is required.',
        details: { command: python, cause: cause.message }
      }
    }));
    child.on('close', (code, signal) => {
      if (timedOut) return;
      if (code !== 0 || !/lve-pptx-runtime-ok/.test(stdout)) {
        settle({
          ok: false,
          error: {
            code: 'PPTX_RENDERER_DEPENDENCIES_MISSING',
            message: 'Python cannot load the editable-PPTX renderer dependencies.',
            details: { command: python, code, signal, stdout, stderr }
          }
        });
        return;
      }
      settle({ ok: true, command: python, rendererPath });
    });
  });
}

async function preflightVerifiedPptx(options = {}) {
  const [desktop, ocr, nativePptx] = await Promise.all([
    preflightDesktopPowerPoint(options),
    preflightBundledOcr(),
    preflightNativePptxRuntime()
  ]);
  const errors = [...(desktop.errors || [])];
  if (!ocr.ok) {
    errors.push({
      code: ocr.error?.code || 'BUNDLED_OCR_PREFLIGHT_FAILED',
      message: ocr.error?.message || 'Bundled Arabic + English OCR is unavailable.',
      details: ocr.error?.details
    });
  }
  if (!nativePptx.ok) errors.push(nativePptx.error);
  return { ...desktop, ocr, nativePptx, errors, ok: errors.length === 0 };
}

// ---- Fidelity evidence retention ----
// Verification artifacts used to land in %TEMP% and were effectively lost, so
// no export was ever inspectable after the fact.  They now live in a
// gitignored `.fidelity/` beside the repo, newest 10 runs kept.
const FIDELITY_ROOT = path.join(__dirname, '..', '.fidelity');
const FIDELITY_RUNS_KEPT = 10;

function ensureFidelityRoot() {
  fs.mkdirSync(FIDELITY_ROOT, { recursive: true });
  try {
    const runs = fs.readdirSync(FIDELITY_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(); // ISO timestamps sort chronologically
    for (const stale of runs.slice(0, Math.max(0, runs.length - (FIDELITY_RUNS_KEPT - 1)))) {
      fs.rmSync(path.join(FIDELITY_ROOT, stale), { recursive: true, force: true });
    }
  } catch (error) {
    console.warn('Could not prune .fidelity runs:', error.message);
  }
  return path.join(FIDELITY_ROOT, new Date().toISOString().replace(/[:.]/g, '-'));
}

// One scoreline per run, so a week of exports reads as a table instead of a
// directory listing.  Numbers only — never the artifacts themselves.
const FIDELITY_INDEX_HEADER = [
  '# Fidelity runs — newest at the bottom',
  '',
  '| timestamp | deck | mode | slides | min ssim | max mismatch% | failures | warnings |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ''
].join('\n');

function appendFidelityIndexRow({ workDir, deckName, evidenceMode, report }) {
  try {
    const indexPath = path.join(FIDELITY_ROOT, 'index.md');
    if (!fs.existsSync(indexPath)) fs.writeFileSync(indexPath, FIDELITY_INDEX_HEADER, 'utf8');
    const slides = report?.slides || [];
    const ssims = slides.map((slide) => slide.visual?.ssim).filter((value) => Number.isFinite(value));
    const mismatches = slides.map((slide) => slide.visual?.mismatchPercent).filter((value) => Number.isFinite(value));
    const cell = (values, pick, digits) => (values.length ? pick(...values).toFixed(digits) : '—');
    const row = [
      path.basename(workDir),
      deckName || '—',
      evidenceMode,
      slides.length || '—',
      cell(ssims, Math.min, 6),
      cell(mismatches, Math.max, 3),
      report?.failures?.length ?? '—',
      report?.warnings?.length ?? '—'
    ];
    fs.appendFileSync(indexPath, `| ${row.join(' | ')} |\n`, 'utf8');
  } catch (error) {
    console.warn('Could not append to .fidelity/index.md:', error.message);
  }
}

async function runVerifiedPptx({ sceneGraph, html, themeCss, baseDir, destinationPath, evidenceMode = 'native' }) {
  if (!sceneGraph || sceneGraph.format !== 'lve.scene-graph' || !Array.isArray(sceneGraph.slides)) {
    return {
      ok: false,
      stage: 'scene-validation',
      error: 'A versioned full-slide scene graph is required for editable PPTX export.'
    };
  }
  // Diagnostic override only.  The product default stays 'native'; the
  // calibration/baseline runs set LVE_EVIDENCE_MODE=full to turn the
  // source-render, PowerPoint-render, OCR and pixel-diff stages back on.
  const requestedMode = process.env.LVE_EVIDENCE_MODE;
  if (['full', 'preview', 'native'].includes(requestedMode)) evidenceMode = requestedMode;
  const workDir = ensureFidelityRoot();
  const result = await verifyAndExport({
    sceneGraph,
    html,
    themeCss: themeCss || sceneGraph.themeCss || '',
    baseDir: baseDir || '',
    destinationPath,
    expectedSlideCount: sceneGraph.slides.length,
    sourceWidth: 1900,
    sourceHeight: 1300,
    // The app exports native, editable PowerPoint objects. OCR and visual
    // comparisons remain in the report, but browser-vs-Office raster
    // differences do not veto an otherwise valid editable deck.
    fidelityPolicy: 'editable-best-effort',
    evidenceMode,
    workDir,
    preflight: preflightVerifiedPptx,
    renderPptx: ({ sceneGraph: graph, outputPath, baseDir: sceneBaseDir }) =>
      renderNativePptx({ sceneGraph: graph, baseDir: sceneBaseDir, suggestedName: outputPath }),
    ocr: runBundledOcr
  });
  appendFidelityIndexRow({
    workDir,
    deckName: destinationPath ? path.basename(destinationPath) : '(preview)',
    evidenceMode,
    report: result.report
  });
  return result;
}

function previewImagesFromReport(report) {
  const paths = (report?.powerPoint?.slides || []).map((slide) => slide.path).filter(Boolean);
  return paths.map((imagePath) => `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`);
}

// The export path publishes after preflight + native-object XML audit so it
// remains responsive. Preview additionally renders the candidate through
// desktop PowerPoint; full OCR/pixel diagnostics are an explicit, slow audit.
// Unsupported content, missing fonts, renderer failures, and native-object
// audit failures remain hard stops.
ipcMain.handle('export-pptx', async (_e, payload) => {
  const { sceneGraph, themeCss, baseDir, suggestedName, html } = payload || {};
  let destinationPath = process.env.LVE_EXPORT_PATH;
  if (!destinationPath) {
    const choice = await dialog.showSaveDialog(mainWindow, {
      title: 'Export editable PPTX (best-effort fidelity)',
      defaultPath: suggestedName || 'lecture.pptx',
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }]
    });
    if (choice.canceled || !choice.filePath) return { ok: false };
    destinationPath = choice.filePath;
  }
  try {
    return await runVerifiedPptx({ sceneGraph, html, themeCss, baseDir, destinationPath });
  } catch (error) {
    console.error('Verified PPTX export error:', error);
    return { ok: false, stage: error.stage || 'export', error: String(error.message || error) };
  }
});

ipcMain.handle('preview-pptx', async (_e, payload) => {
  const { sceneGraph, themeCss, baseDir, html } = payload || {};
  try {
    const result = await runVerifiedPptx({ sceneGraph, html, themeCss, baseDir, destinationPath: null, evidenceMode: 'preview' });
    if (!result.ok) return result;
    return { ...result, images: previewImagesFromReport(result.report) };
  } catch (error) {
    console.error('Verified PPTX preview error:', error);
    return { ok: false, stage: error.stage || 'preview', error: String(error.message || error) };
  }
});

// ---- PDF quick preview: same render path as export, shown in a viewer window ----
ipcMain.handle('preview-pdf', async (_e, { html, pageSize }) => {
  try {
    const data = await renderPdfBuffer(html, pageSize);
    const pdfPath = path.join(os.tmpdir(), `lve-preview-${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, data);
    const viewer = new BrowserWindow({
      width: 1000,
      height: 800,
      title: 'PDF Preview',
      webPreferences: { plugins: true }
    });
    viewer.setMenuBarVisibility(false);
    viewer.on('closed', () => fs.unlink(pdfPath, () => {}));
    await viewer.loadURL(require('url').pathToFileURL(pdfPath).href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});
