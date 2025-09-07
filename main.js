import { app, BrowserWindow, ipcMain, webContents } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

let win;

function createWindow(){
  const preloadPath = path.join(__dirname, 'preload.cjs');
  console.log('[Crumple] Using preload:', preloadPath);

  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0b0b10',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC bridges
ipcMain.handle('capture', async (e, { id }) => {
  const wc = webContents.fromId(id);
  if (!wc) return null;
  const image = await wc.capturePage();
  return image.toDataURL();
});

ipcMain.handle('send-input', async (e, { id, event }) => {
  const wc = webContents.fromId(id);
  if (!wc) return false;
  try { wc.sendInputEvent(event); return true; } catch { return false; }
});
