const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// ---- Export PDF (clean render in a hidden window) ----
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
    const data = await pdfWin.webContents.printToPDF(opts);
    fs.writeFileSync(filePath, data);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    pdfWin.destroy();
    fs.unlink(tmp, () => {});
  }
});
