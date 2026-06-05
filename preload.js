const { contextBridge, ipcRenderer } = require('electron');

// Sichere Brücke für das Updater-Fenster
contextBridge.exposeInMainWorld('dayone', {
  // Aktionen
  check: () => ipcRenderer.invoke('updater:check'),
  install: () => ipcRenderer.invoke('updater:install'),
  repair: () => ipcRenderer.invoke('updater:repair'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  // Status-Events vom Main-Prozess
  onStatus: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
});
