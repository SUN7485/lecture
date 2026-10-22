const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openHtml: () => ipcRenderer.invoke('open-html'),
  openDocx: () => ipcRenderer.invoke('open-docx'),
  // PDF import is two calls so the renderer can paint a progress status
  // between the file dialog closing and the (blocking) reconstruction.
  pickPdf: () => ipcRenderer.invoke('pick-pdf'),
  importPdf: (payload) => ipcRenderer.invoke('import-pdf', payload),
  importHtml: () => ipcRenderer.invoke('import-html'),
  autoOpen: () => ipcRenderer.invoke('auto-open'),
  getLastFile: () => ipcRenderer.invoke('get-last-file'),
  pickImages: () => ipcRenderer.invoke('pick-images'),
  getFonts: () => ipcRenderer.invoke('get-fonts'),
  saveHtml: (payload) => ipcRenderer.invoke('save-html', payload),
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  previewPdf: (payload) => ipcRenderer.invoke('preview-pdf', payload),
  exportPptx: (payload) => ipcRenderer.invoke('export-pptx', payload),
  previewPptx: (payload) => ipcRenderer.invoke('preview-pptx', payload),
  // A verified export renders the deck twice (Chromium + real PowerPoint) and
  // compares every slide, so it can take a minute on a long lecture. Without
  // stage updates the UI looks frozen. Returns an unsubscribe function.
  onPptxProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('pptx-progress', listener);
    return () => ipcRenderer.removeListener('pptx-progress', listener);
  },

  // ---- AI enrichment ----
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  aiReloadConfig: () => ipcRenderer.invoke('ai-reload-config'),
  aiChat: (payload) => ipcRenderer.invoke('ai-chat', payload),
  aiImage: (payload) => ipcRenderer.invoke('ai-image', payload),
  enrichCacheRead: (payload) => ipcRenderer.invoke('enrich-cache-read', payload),
  enrichCacheWrite: (payload) => ipcRenderer.invoke('enrich-cache-write', payload),

  // ---- Settings (API keys) ----
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSave: (payload) => ipcRenderer.invoke('settings-save', payload),

  // ---- Brand kits (custom fonts + palette) ----
  pickFonts: () => ipcRenderer.invoke('pick-fonts'),
  brandKitsGet: () => ipcRenderer.invoke('brandkits-get'),
  brandKitsSave: (kit) => ipcRenderer.invoke('brandkits-save', kit),
  brandKitsDelete: (name) => ipcRenderer.invoke('brandkits-delete', name),

  // ---- Generic text file save/open (theme files, etc.) ----
  saveTextFile: (payload) => ipcRenderer.invoke('save-text-file', payload),
  openTextFile: (payload) => ipcRenderer.invoke('open-text-file', payload)
});
