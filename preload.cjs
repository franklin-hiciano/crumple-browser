const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  capture: (webContentsId) => ipcRenderer.invoke('capture', { id: webContentsId }),
  sendInput: (webContentsId, event) => ipcRenderer.invoke('send-input', { id: webContentsId, event }),
});
