import { app, BrowserWindow, ipcMain, Notification, nativeImage } from 'electron';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { NotificationDetector } from './notification-detector';
import { NotificationStateManager } from './notification-state';
import { registerIpcHandlers } from './ipc-handlers';
import { SettingsStore } from './settings-store';
import { IPC_CHANNELS, SOCKET_PATH } from '../shared/constants';
import { SocketApi } from './socket-api';
import { FleetCommandHandler } from './socket-command-handler';
import { AgentStateTracker } from './agent-state-tracker';
import { JsonlWatcher } from './jsonl-watcher';
import { CLAUDE_PROJECTS_DIR } from '../shared/constants';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

let mainWindow: BrowserWindow | null = null;
const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();
const settingsStore = new SettingsStore();
const notificationDetector = new NotificationDetector(eventBus);
const notificationState = new NotificationStateManager(eventBus);
const commandHandler = new FleetCommandHandler(ptyManager, layoutStore, eventBus, notificationState);
const socketApi = new SocketApi(SOCKET_PATH, commandHandler);
const agentTracker = new AgentStateTracker(eventBus);
const jsonlWatcher = new JsonlWatcher(CLAUDE_PROJECTS_DIR);

function createWindow(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const iconPath = join(__dirname, '../../build/icon.png');

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.mjs', import.meta.url)),
      sandbox: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
  });

  // Log renderer console messages and errors to main process stdout
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`[renderer] ${message}`);
  });

  mainWindow.on('close', () => {
    ptyManager.killAll();
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

app.setName('Fleet');

app.whenReady().then(() => {
  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    const dockIconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png');
    const dockIcon = nativeImage.createFromPath(dockIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon);
    }
  }

  registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, notificationState, settingsStore, () => mainWindow);

  // Wire socket command handler to the window
  commandHandler.setWindowGetter(() => mainWindow);

  // Start socket API
  socketApi.start().catch((err) => {
    console.error('Failed to start socket API:', err);
  });

  // Wire JSONL watcher to agent state tracker
  // Maps JSONL sessionId → Fleet paneId
  const sessionToPaneMap = new Map<string, string>();

  jsonlWatcher.onRecord((sessionId, record) => {
    // Already mapped?
    const existingPane = sessionToPaneMap.get(sessionId);
    if (existingPane) {
      agentTracker.handleJsonlRecord(existingPane, record);
      return;
    }

    // Correlate by matching the record's cwd to a pane's cwd
    // Use the most specific (longest) matching pane CWD to avoid
    // parent dirs like ~ matching everything.
    const recordCwd = (record as { cwd?: string }).cwd;
    if (recordCwd) {
      const mappedPanes = new Set(sessionToPaneMap.values());
      const activePanes = ptyManager.paneIds();

      let bestPane: string | null = null;
      let bestLen = 0;

      for (const paneId of activePanes) {
        if (mappedPanes.has(paneId)) continue;
        const paneCwd = ptyManager.getCwd(paneId);
        if (paneCwd && recordCwd.startsWith(paneCwd) && paneCwd.length > bestLen) {
          bestPane = paneId;
          bestLen = paneCwd.length;
        }
      }

      if (bestPane) {
        sessionToPaneMap.set(sessionId, bestPane);
        agentTracker.handleJsonlRecord(bestPane, record);
        return;
      }
    }
  });

  jsonlWatcher.start();

  // Forward agent state changes to renderer and socket API
  eventBus.on('agent-state-change', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATE, {
        states: agentTracker.getAllStates(),
      });
    }

    socketApi.broadcastEvent('agent-state-change', {
      paneId: event.paneId,
      state: event.state,
      tool: event.tool,
    });
  });

  // Clean up session mapping when panes close
  eventBus.on('pane-closed', (event) => {
    for (const [sessionId, paneId] of sessionToPaneMap) {
      if (paneId === event.paneId) {
        sessionToPaneMap.delete(sessionId);
        break;
      }
    }
  });

  // Forward notification events to renderer
  eventBus.on('notification', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATION, {
        paneId: event.paneId,
        level: event.level,
        timestamp: event.timestamp,
      });
    }
  });

  // Broadcast events to socket subscribers
  eventBus.on('notification', (event) => {
    socketApi.broadcastEvent('notification', {
      paneId: event.paneId,
      level: event.level,
      timestamp: event.timestamp,
    });
  });

  eventBus.on('pane-created', (event) => {
    socketApi.broadcastEvent('pane-created', { paneId: event.paneId });
  });

  eventBus.on('pane-closed', (event) => {
    socketApi.broadcastEvent('pane-closed', { paneId: event.paneId });
  });

  eventBus.on('workspace-loaded', (event) => {
    socketApi.broadcastEvent('workspace-loaded', { workspaceId: event.workspaceId });
  });

  // Emit notification on PTY exit
  eventBus.on('pty-exit', (event) => {
    const level = event.exitCode !== 0 ? 'error' : 'subtle';
    eventBus.emit('notification', {
      type: 'notification',
      paneId: event.paneId,
      level,
      timestamp: Date.now(),
    });
  });

  // OS notifications — coalesced to prevent burst fatigue (Baymard/NNG)
  let pendingOsNotifications: Array<{ paneId: string; level: string }> = [];
  let osNotifTimer: ReturnType<typeof setTimeout> | null = null;
  const OS_NOTIF_BATCH_MS = 500; // batch window for coalescing

  function flushOsNotifications(): void {
    if (pendingOsNotifications.length === 0) return;

    const batch = pendingOsNotifications;
    pendingOsNotifications = [];
    osNotifTimer = null;

    if (!Notification.isSupported()) return;

    const hasPermission = batch.some((n) => n.level === 'permission');
    const hasError = batch.some((n) => n.level === 'error');

    let body: string;
    if (batch.length === 1) {
      body = hasPermission
        ? 'An agent needs your permission'
        : hasError
          ? 'A process exited with an error'
          : 'Task completed';
    } else {
      const parts: string[] = [];
      const permCount = batch.filter((n) => n.level === 'permission').length;
      const errCount = batch.filter((n) => n.level === 'error').length;
      const infoCount = batch.length - permCount - errCount;
      if (permCount > 0) parts.push(`${permCount} need${permCount > 1 ? '' : 's'} permission`);
      if (errCount > 0) parts.push(`${errCount} error${errCount > 1 ? 's' : ''}`);
      if (infoCount > 0) parts.push(`${infoCount} completed`);
      body = `${batch.length} agents: ${parts.join(', ')}`;
    }

    const notif = new Notification({ title: 'Fleet', body });
    notif.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      // Focus the first pane from the batch (most recent high-priority)
      const target = batch.find((n) => n.level === 'permission')
        ?? batch.find((n) => n.level === 'error')
        ?? batch[0];
      mainWindow?.webContents.send('fleet:focus-pane', { paneId: target.paneId });
    });
    notif.show();
  }

  eventBus.on('notification', (event) => {
    const settings = settingsStore.get();

    const settingsKey = {
      permission: 'needsPermission',
      error: 'processExitError',
      info: 'taskComplete',
      subtle: 'processExitClean',
    }[event.level] as keyof typeof settings.notifications;

    const config = settings.notifications[settingsKey];

    if (config.os) {
      pendingOsNotifications.push({ paneId: event.paneId, level: event.level });
      if (!osNotifTimer) {
        osNotifTimer = setTimeout(flushOsNotifications, OS_NOTIF_BATCH_MS);
      }
    }
  });

  createWindow();

  // Auto-updater — checks GitHub Releases for updates
  autoUpdater.checkForUpdatesAndNotify().catch(() => {
    // Silently fail if no internet or no releases configured
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('fleet:update-downloaded');
  });

  ipcMain.on('fleet:install-update', () => {
    autoUpdater.quitAndInstall();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  ptyManager.killAll();
  socketApi.stop();
  jsonlWatcher.stop();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
