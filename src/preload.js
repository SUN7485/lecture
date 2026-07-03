const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openHtml: () => ipcRenderer.invoke('open-html'),
  autoOpen: () => ipcRenderer.invoke('auto-open'),
  getLastFile: () => ipcRenderer.invoke('get-last-file'),
  pickImages: () => ipcRenderer.invoke('pick-images'),
  saveHtml: (payload) => ipcRenderer.invoke('save-html', payload),
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload)
});
