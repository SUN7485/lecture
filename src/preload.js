const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openHtml: () => ipcRenderer.invoke('open-html'),
  importHtml: () => ipcRenderer.invoke('import-html'),
  autoOpen: () => ipcRenderer.invoke('auto-open'),
  getLastFile: () => ipcRenderer.invoke('get-last-file'),
  pickImages: () => ipcRenderer.invoke('pick-images'),
  getFonts: () => ipcRenderer.invoke('get-fonts'),
  saveHtml: (payload) => ipcRenderer.invoke('save-html', payload),
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),

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
  brandKitsDelete: (name) => ipcRenderer.invoke('brandkits-delete', name)
});
