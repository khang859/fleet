import { app, BrowserWindow } from 'electron';
import { fileURLToPath } from 'url';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { registerIpcHandlers } from './ipc-handlers';

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      sandbox: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
  });

  // Log renderer console messages and errors to main process stdout
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    console.log(`[renderer] ${message}`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[renderer] Failed to load: ${errorCode} ${errorDescription}`);
  });

  mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Debug: log DOM state after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      mainWindow!.webContents.executeJavaScript(`
        const root = document.getElementById('root');
        const xterm = document.querySelector('.xterm');
        const container = document.querySelector('[class*="h-full"][class*="w-full"]');
        const main = document.querySelector('main');
        JSON.stringify({
          mainHTML: main?.innerHTML.substring(0, 500),
          mainChildren: main?.children.length,
          mainDims: main ? { w: main.clientWidth, h: main.clientHeight } : null,
        })
      `).then(r => console.log('[debug DOM]', r)).catch(e => console.log('[debug err]', e));
    }, 3000);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers(ptyManager, layoutStore, eventBus, () => mainWindow);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
