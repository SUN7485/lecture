const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openHtml: () => ipcRenderer.invoke('open-html'),
  autoOpen: () => ipcRenderer.invoke('auto-open'),
  pickImages: () => ipcRenderer.invoke('pick-images'),
  saveHtml: (payload) => ipcRenderer.invoke('save-html', payload),
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload)
});
