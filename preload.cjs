const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("native", {
  capture: (webContentsId) =>
    ipcRenderer.invoke("capture", { id: webContentsId }),
  sendInput: (webContentsId, event) =>
    ipcRenderer.invoke("send-input", { id: webContentsId, event }),
});

contextBridge.exposeInMainWorld("live", {
  start: (url, width, height, fps) =>
    ipcRenderer.invoke("live-start", { url, width, height, fps }),
  resize: (width, height) =>
    ipcRenderer.invoke("live-resize", { width, height }),
  stop: () => ipcRenderer.invoke("live-stop"),
  onFrame: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on("live-frame", h);
    return () => ipcRenderer.removeListener("live-frame", h);
  },
});
