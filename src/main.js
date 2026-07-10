const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ai = require('./enrich/ai');

let mainWindow;

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
