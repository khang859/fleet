import { app, BrowserWindow, ipcMain, Notification, nativeImage, net, protocol } from 'electron';
import { safeOpenExternal } from './safe-external';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { NotificationDetector } from './notification-detector';
import { ActivityTracker } from './activity-tracker';
import { NotificationStateManager } from './notification-state';
import { registerIpcHandlers } from './ipc-handlers';
import { GitService } from './git-service';
import { SettingsStore } from './settings-store';
import { IPC_CHANNELS, SOCKET_PATH } from '../shared/constants';
import { SocketSupervisor } from './socket-supervisor';
import { CwdPoller } from './cwd-poller';
import { installFleetCLI, installSkillFile } from './install-fleet-cli';
import { ImageService } from './image-service';
import { WorktreeService } from './worktree-service';
import { enrichProcessEnv } from './shell-env';
import { resolveBootstrapWorkspacePath } from './workspace-path';
import type { HostContextPayload } from '../shared/ipc-api';
import type { NotificationLevel, UpdateStatus, ImageSettings } from '../shared/types';
import { createLogger } from './logger';
import { initCopilot, stopCopilot } from './copilot/index';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const log = createLogger('fleet-main');
const updaterLog = createLogger('auto-updater');

let mainWindow: BrowserWindow | null = null;
let socketSupervisor: SocketSupervisor | null = null;
const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();
const settingsStore = new SettingsStore();
const notificationDetector = new NotificationDetector(eventBus);
const notificationState = new NotificationStateManager(eventBus);
const activityTracker = new ActivityTracker(eventBus, {
  silenceThresholdMs: 5000,
  processPollingIntervalMs: 2000,
  getProcessName: (paneId) => ptyManager.getProcessName(paneId),
});
const cwdPoller = new CwdPoller(eventBus, ptyManager);
const imageService = new ImageService();
imageService.on('changed', (id: string) => {
  const windowRef = mainWindow;
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send(IPC_CHANNELS.IMAGES_CHANGED, { id });
  }
});
log.info('startup marker', { runtime: 'spawn-ipc', preload: 'out/preload/index.js' });

function getHostPlatform(): HostContextPayload['platform'] {
  const p = process.platform;
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  throw new Error(`Unsupported platform: ${p}`);
}

ipcMain.handle(
  IPC_CHANNELS.APP_HOST_CONTEXT_GET,
  (): HostContextPayload => ({
    homeDir: homedir(),
    platform: getHostPlatform()
  })
);

function createWindow(): void {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const iconPath = join(__dirname, '../../build/icon.png');
  const preloadPathJs = fileURLToPath(new URL('../preload/index.js', import.meta.url));
  const preloadPathMjs = fileURLToPath(new URL('../preload/index.mjs', import.meta.url));
  const preloadPath = existsSync(preloadPathJs) ? preloadPathJs : preloadPathMjs;

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: nativeImage.createFromPath(iconPath),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#0a0a0a', symbolColor: '#a3a3a3', height: 36 } })
  });

  // Log renderer console messages and errors to main process stdout.
  // Skip messages from the renderer logger (tag format [xxx:yyy]) — those are
  // already captured via the LOG_BATCH IPC bridge with proper structured metadata.
  mainWindow.webContents.on('console-message', (event) => {
    if (event.message.startsWith('%c') && /\[[\w:]+\]/.test(event.message)) return;
    log.info(event.message, { renderer: true });
  });

  mainWindow.on('close', () => {
    ptyManager.killAll();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log.error('renderer failed to load', { errorCode, errorDescription });
  });

  // Intercept navigation away from app (e.g. <a href> without target)
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      event.preventDefault();
      void safeOpenExternal(url);
    }
  });

  // Intercept window.open / target="_blank" links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void safeOpenExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });

    // Debug: log DOM state after page loads
    mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        mainWindow?.webContents
          .executeJavaScript(
            `
          const root = document.getElementById('root');
          const xterm = document.querySelector('.xterm');
          const container = document.querySelector('[class*="h-full"][class*="w-full"]');
          const main = document.querySelector('main');
          JSON.stringify({
            mainHTML: main?.innerHTML.substring(0, 500),
            mainChildren: main?.children.length,
            mainDims: main ? { w: main.clientWidth, h: main.clientHeight } : null,
          })
        `
          )
          .then((r: unknown) => log.debug('debug DOM', { result: String(r) }))
          .catch((e: unknown) => log.debug('debug err', { error: String(e) }));
      }, 3000);
    });
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)));
  }
}

app.setName('Fleet');

// Single instance lock — prevent multiple Fleet instances from fighting over fleet.sock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Register fleet-image:// protocol to serve local images without base64 IPC overhead
protocol.registerSchemesAsPrivileged([
  { scheme: 'fleet-image', privileges: { supportFetchAPI: true, stream: true } }
]);

void app.whenReady().then(async () => {
  protocol.handle('fleet-image', async (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname);
    return net.fetch(`file://${filePath}`);
  });

  createWindow();

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    const dockIconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png');
    const dockIcon = nativeImage.createFromPath(dockIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon);
    }
  }

  const gitService = new GitService();
  const workspacePath = resolveBootstrapWorkspacePath({
    cwd: process.cwd(),
    pwd: process.env.PWD,
    isPackaged: app.isPackaged
  });
  void enrichProcessEnv();
  void installSkillFile().catch((err) => {
    log.warn('failed to install skill file', { error: err instanceof Error ? err.message : String(err) });
  });
  void installFleetCLI()
    .catch((err: unknown) => {
      log.error('failed to install CLI binary', {
        error: err instanceof Error ? err.message : String(err)
      });
      return join(homedir(), '.fleet', 'bin');
    })
    .then((fleetBinPath) => {
      const pathDirs = (process.env.PATH ?? '').split(':');
      if (!pathDirs.includes(fleetBinPath)) {
        process.env.PATH = fleetBinPath + ':' + (process.env.PATH ?? '');
      }
    });

  registerIpcHandlers(
    ptyManager,
    layoutStore,
    eventBus,
    notificationDetector,
    notificationState,
    settingsStore,
    cwdPoller,
    gitService,
    () => mainWindow,
    workspacePath,
    activityTracker,
    new WorktreeService()
  );

  imageService.resumeInterrupted();

  // Start socket server for fleet CLI (images + open commands)
  socketSupervisor = new SocketSupervisor(SOCKET_PATH, imageService);
  socketSupervisor.on('file-open', (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, payload);
    }
  });
  socketSupervisor.start().catch((err: unknown) => {
    log.error('socket-supervisor failed to start', {
      error: err instanceof Error ? err.message : String(err)
    });
  });

  // Start copilot (macOS only, gated internally)
  await initCopilot(settingsStore);

  // Clean up CWD polling and activity tracking when panes close
  eventBus.on('pane-closed', (event) => {
    cwdPoller.stopPolling(event.paneId);
    activityTracker.untrackPane(event.paneId);
  });

  // Forward CWD changes to renderer and keep ptyManager in sync
  eventBus.on('cwd-changed', (event) => {
    ptyManager.updateCwd(event.paneId, event.cwd);
    if (event.source === 'osc7') {
      cwdPoller.markOsc7Seen(event.paneId);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PTY_CWD, {
        paneId: event.paneId,
        cwd: event.cwd
      });
    }
  });

  // Forward notification events to renderer
  eventBus.on('notification', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.NOTIFICATION, {
        paneId: event.paneId,
        level: event.level,
        timestamp: event.timestamp
      });
    }
    // Bridge permission notifications to activity tracker
    if (event.level === 'permission') {
      activityTracker.onNeedsMe(event.paneId);
    }
  });

  // Emit notification on PTY exit
  eventBus.on('pty-exit', (event) => {
    const level = event.exitCode !== 0 ? 'error' : 'subtle';
    eventBus.emit('notification', {
      type: 'notification',
      paneId: event.paneId,
      level,
      timestamp: Date.now()
    });
    activityTracker.onExit(event.paneId, event.exitCode);
  });

  // Forward activity state changes to renderer via IPC
  eventBus.on('activity-state-change', (event) => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.ACTIVITY_STATE, {
        paneId: event.paneId,
        state: event.state,
        lastOutputAt: event.lastOutputAt,
        timestamp: event.timestamp,
      });
    }
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
      const target =
        batch.find((n) => n.level === 'permission') ??
        batch.find((n) => n.level === 'error') ??
        batch[0];
      mainWindow?.webContents.send('fleet:focus-pane', { paneId: target.paneId });
    });
    notif.show();
  }

  eventBus.on('notification', (event) => {
    const settings = settingsStore.get();

    const notifKeyMap: Record<NotificationLevel, keyof typeof settings.notifications> = {
      permission: 'needsPermission',
      error: 'processExitError',
      info: 'taskComplete',
      subtle: 'processExitClean'
    };
    const settingsKey = notifKeyMap[event.level];

    const config = settings.notifications[settingsKey];

    if (config.os) {
      pendingOsNotifications.push({ paneId: event.paneId, level: event.level });
      osNotifTimer ??= setTimeout(flushOsNotifications, OS_NOTIF_BATCH_MS);
    }
  });

  // --- Auto-updater: unified status pipeline ---
  // Allow checking for updates in dev mode via dev-app-update.yml
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }

  let updateState: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle';
  let pendingVersion = '';
  let pendingReleaseNotes = '';

  function normalizeReleaseNotes(
    notes: string | Array<{ note: string | null }> | null | undefined
  ): string {
    if (!notes) return '';
    if (typeof notes === 'string') return notes;
    if (Array.isArray(notes)) return notes.map((n) => n.note ?? '').join('\n');
    return '';
  }

  function sendUpdateStatus(status: UpdateStatus): void {
    updaterLog.info('status', { state: status.state });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('fleet:update-status', status);
    }
  }

  autoUpdater.on('checking-for-update', () => {
    updateState = 'checking';
    sendUpdateStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    updateState = 'downloading';
    pendingVersion = info.version;
    pendingReleaseNotes = normalizeReleaseNotes(info.releaseNotes);
    sendUpdateStatus({
      state: 'downloading',
      version: pendingVersion,
      releaseNotes: pendingReleaseNotes,
      percent: 0
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus({
      state: 'downloading',
      version: pendingVersion,
      releaseNotes: pendingReleaseNotes,
      percent: Math.round(progress.percent)
    });
  });

  autoUpdater.on('update-downloaded', () => {
    updateState = 'ready';
    sendUpdateStatus({
      state: 'ready',
      version: pendingVersion,
      releaseNotes: pendingReleaseNotes
    });
  });

  autoUpdater.on('update-not-available', () => {
    updateState = 'idle';
    sendUpdateStatus({ state: 'not-available' });
  });

  autoUpdater.on('error', (err) => {
    updateState = 'idle';
    sendUpdateStatus({ state: 'error', message: err.message });
  });

  // Image generation IPC handlers
  ipcMain.handle(
    IPC_CHANNELS.IMAGES_GENERATE,
    (_e, opts: Parameters<typeof imageService.generate>[0]) => imageService.generate(opts)
  );
  ipcMain.handle(IPC_CHANNELS.IMAGES_EDIT, (_e, opts: Parameters<typeof imageService.edit>[0]) =>
    imageService.edit(opts)
  );
  ipcMain.handle(IPC_CHANNELS.IMAGES_STATUS, (_e, id: string) => imageService.getStatus(id));
  ipcMain.handle(IPC_CHANNELS.IMAGES_LIST, () => imageService.list());
  ipcMain.handle(IPC_CHANNELS.IMAGES_RETRY, (_e, id: string) => imageService.retry(id));
  ipcMain.handle(IPC_CHANNELS.IMAGES_DELETE, (_e, id: string) => {
    imageService.delete(id);
  });
  ipcMain.handle(IPC_CHANNELS.IMAGES_CONFIG_GET, () => {
    const settings = imageService.getSettings();
    const redacted = { ...settings, providers: { ...settings.providers } };
    for (const [key, val] of Object.entries(redacted.providers)) {
      redacted.providers[key] = {
        ...val,
        apiKey: val.apiKey ? `${val.apiKey.slice(0, 4)}***` : ''
      };
    }
    return redacted;
  });
  ipcMain.handle(IPC_CHANNELS.IMAGES_CONFIG_SET, (_e, partial: Partial<ImageSettings>) => {
    imageService.updateSettings(partial);
  });
  ipcMain.handle(
    IPC_CHANNELS.IMAGES_RUN_ACTION,
    (_e, opts: { actionType: string; source: string; provider?: string }) =>
      imageService.runAction(opts)
  );
  ipcMain.handle(IPC_CHANNELS.IMAGES_LIST_ACTIONS, (_e, provider?: string) =>
    imageService.listActions(provider)
  );

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    if (updateState === 'checking' || updateState === 'downloading') return;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      sendUpdateStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Update check failed'
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_VERSION, () => app.getVersion());

  ipcMain.on(IPC_CHANNELS.UPDATE_INSTALL, () => {
    autoUpdater.quitAndInstall();
  });

  // Silent check on launch (packaged builds only)
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      updaterLog.error('auto-update check failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function shutdownAll(): void {
  void stopCopilot();
  ptyManager.killAll();
  cwdPoller.stopAll();
  socketSupervisor?.stop().catch((err: unknown) =>
    log.error('socket-supervisor stop error', {
      error: err instanceof Error ? err.message : String(err)
    })
  );
  imageService.shutdown();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    shutdownAll();
    app.quit();
  }
  // On macOS: app stays running in the dock — keep services alive so the
  // fleet CLI and socket remain usable while the window is closed.
});

app.on('will-quit', () => {
  shutdownAll();
});

// Ensure child processes are cleaned up on unexpected termination
process.on('SIGTERM', () => {
  shutdownAll();
  process.exit(0);
});
process.on('SIGINT', () => {
  shutdownAll();
  process.exit(0);
});
