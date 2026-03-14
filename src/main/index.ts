import { app, BrowserWindow, Notification } from 'electron';
import { fileURLToPath } from 'url';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { NotificationDetector } from './notification-detector';
import { NotificationStateManager } from './notification-state';
import { registerIpcHandlers } from './ipc-handlers';
import { IPC_CHANNELS, DEFAULT_SETTINGS } from '../shared/constants';

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();
const notificationDetector = new NotificationDetector(eventBus);
const notificationState = new NotificationStateManager(eventBus);

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
  registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, notificationState, () => mainWindow);

  // Forward notification events to renderer
  eventBus.on('notification', (event) => {
    mainWindow?.webContents.send(IPC_CHANNELS.NOTIFICATION, {
      paneId: event.paneId,
      level: event.level,
      timestamp: event.timestamp,
    });
  });

  // OS notifications
  eventBus.on('notification', (event) => {
    const settings = DEFAULT_SETTINGS; // Will read from settings store in Layer 5

    const settingsKey = {
      permission: 'needsPermission',
      error: 'processExitError',
      info: 'taskComplete',
      subtle: 'processExitClean',
    }[event.level] as keyof typeof settings.notifications;

    const config = settings.notifications[settingsKey];

    if (config.os && Notification.isSupported()) {
      const notif = new Notification({
        title: 'Fleet',
        body: event.level === 'permission'
          ? 'An agent needs your permission'
          : 'Task completed',
      });
      notif.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send('fleet:focus-pane', { paneId: event.paneId });
      });
      notif.show();
    }
  });

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
