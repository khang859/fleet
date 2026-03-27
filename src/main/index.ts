import { app, BrowserWindow, ipcMain, Notification, nativeImage } from 'electron';
import { safeOpenExternal } from './safe-external';
import { appendFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { NotificationDetector } from './notification-detector';
import { NotificationStateManager } from './notification-state';
import { registerIpcHandlers } from './ipc-handlers';
import { GitService } from './git-service';
import { SettingsStore } from './settings-store';
import { IPC_CHANNELS, SOCKET_PATH } from '../shared/constants';
import { SocketSupervisor } from './socket-supervisor';
import { FleetCommandHandler } from './socket-command-handler';
import { AgentStateTracker } from './agent-state-tracker';
import { JsonlWatcher } from './jsonl-watcher';
import { CwdPoller } from './cwd-poller';
import { CLAUDE_PROJECTS_DIR } from '../shared/constants';
import { AdmiralProcess } from './starbase/admiral-process';
import { AdmiralStateDetector } from './starbase/admiral-state-detector';
import { installFleetCLI } from './install-fleet-cli';
import { ImageService } from './image-service';
import { enrichProcessEnv } from './shell-env';
import { normalizeRuntimeEnv } from './runtime-env';
import { resolveBootstrapWorkspacePath } from './workspace-path';
import type { HostContextPayload, StarbaseRuntimeStatus } from '../shared/ipc-api';
import type { NotificationLevel, UpdateStatus, ImageSettings } from '../shared/types';
import { StarbaseRuntimeClient } from './starbase-runtime-client';
import { createSocketRuntimeServices } from './starbase-runtime-socket-services';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

let mainWindow: BrowserWindow | null = null;
let lastUnreadCommsCount = 0;
let lastUnreadMemosCount = 0;
let socketSupervisor: SocketSupervisor | null = null;
let admiralProcess: AdmiralProcess | null = null;
const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();
const settingsStore = new SettingsStore();
const notificationDetector = new NotificationDetector(eventBus);
const notificationState = new NotificationStateManager(eventBus);
const commandHandler = new FleetCommandHandler(
  ptyManager,
  layoutStore,
  eventBus,
  notificationState
);
const cwdPoller = new CwdPoller(eventBus, ptyManager);
const agentTracker = new AgentStateTracker(eventBus);
const jsonlWatcher = new JsonlWatcher(CLAUDE_PROJECTS_DIR);
const admiralStateDetector = new AdmiralStateDetector(eventBus);
const runtimeClient = new StarbaseRuntimeClient(
  new URL('./starbase-runtime-process.mjs', import.meta.url)
);
const imageService = new ImageService();
imageService.on('changed', (id: string) => {
  const windowRef = mainWindow;
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send(IPC_CHANNELS.IMAGES_CHANGED, { id });
  }
});
const STARBASE_PARENT_TRACE_FILE = '/tmp/fleet-starbase-parent.log';

// eslint-disable-next-line no-console
console.log('[fleet-main] startup marker runtime=spawn-ipc preload=out/preload/index.js');

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function traceStarbase(message: string, extra?: unknown): void {
  const suffix = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  try {
    appendFileSync(
      STARBASE_PARENT_TRACE_FILE,
      `[${new Date().toISOString()} pid=${process.pid}] main ${message}${suffix}\n`,
      'utf8'
    );
  } catch {
    // Ignore trace write failures.
  }
}

traceStarbase('startup marker', {
  runtime: 'spawn-ipc',
  preload: 'out/preload/index.js'
});

let runtimeStatus: StarbaseRuntimeStatus = { state: 'starting' };

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

function setRuntimeStatus(status: StarbaseRuntimeStatus): void {
  runtimeStatus = status;
  traceStarbase('runtime status updated', status);
  const windowRef = mainWindow;
  if (windowRef && !windowRef.isDestroyed()) {
    windowRef.webContents.send(IPC_CHANNELS.STARBASE_RUNTIME_STATUS_CHANGED, status);
  }
}

async function handleStarbaseSnapshot(snapshot: Record<string, unknown>): Promise<void> {
  const windowRef = mainWindow;
  if (!windowRef || windowRef.isDestroyed()) {
    return;
  }

  windowRef.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, snapshot);

  const unreadCount = Number(snapshot.unreadCount ?? 0);
  const foRaw = snapshot.firstOfficer;
  const unreadMemosCount = Number(
    (foRaw != null && typeof foRaw === 'object' && 'unreadMemos' in foRaw
      ? foRaw.unreadMemos
      : 0) ?? 0
  );

  if (unreadCount > lastUnreadCommsCount && Notification.isSupported()) {
    const settings = settingsStore.get();
    if (settings.notifications.comms.os) {
      const allUnread = await runtimeClient.invoke<Array<{ from_crew?: string }>>(
        'comms.getUnread',
        'admiral'
      );
      const newComms = (Array.isArray(allUnread) ? allUnread : []).slice(lastUnreadCommsCount);
      const body =
        newComms.length === 1
          ? `New transmission from ${newComms[0]?.from_crew ?? 'crew'}`
          : `${newComms.length} new transmissions`;
      const notif = new Notification({ title: 'Fleet', body });
      notif.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send(IPC_CHANNELS.FOCUS_COMMS);
      });
      notif.show();
    }
  }
  lastUnreadCommsCount = unreadCount;

  if (unreadMemosCount > lastUnreadMemosCount && Notification.isSupported()) {
    const settings = settingsStore.get();
    if (settings.notifications.memos.os) {
      const notif = new Notification({
        title: 'Fleet — First Officer',
        body: 'New memo requires review'
      });
      notif.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send(IPC_CHANNELS.FOCUS_FIRST_OFFICER);
      });
      notif.show();
    }
  }
  lastUnreadMemosCount = unreadMemosCount;
}

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

  // Log renderer console messages and errors to main process stdout
  mainWindow.webContents.on('console-message', (event) => {
    // eslint-disable-next-line no-console
    console.log(`[renderer] ${event.message}`);
  });

  mainWindow.on('close', () => {
    ptyManager.killAll();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error(`[renderer] Failed to load: ${errorCode} ${errorDescription}`);
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
          // eslint-disable-next-line no-console
          .then((r) => console.log('[debug DOM]', r))
          // eslint-disable-next-line no-console
          .catch((e) => console.log('[debug err]', e));
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

app.on('child-process-gone', (_event, details) => {
  if (details.type === 'Utility' || details.serviceName === 'Fleet Starbase Runtime') {
    console.error('[child-process-gone]', details);
  }
});

void app.whenReady().then(() => {
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
  const envReady = enrichProcessEnv();
  const cliReady = installFleetCLI()
    .catch((err) => {
      console.error('[fleet-cli] Failed to install CLI binary:', err);
      return join(homedir(), '.fleet', 'bin');
    })
    .then((fleetBinPath) => {
      const pathDirs = (process.env.PATH ?? '').split(':');
      if (!pathDirs.includes(fleetBinPath)) {
        process.env.PATH = fleetBinPath + ':' + (process.env.PATH ?? '');
      }
      return fleetBinPath;
    });

  let starbaseReadyPromise: Promise<void> = Promise.resolve();
  let starbaseBootstrapInFlight: Promise<void> | null = null;

  const bootstrapStarbase = async (): Promise<void> => {
    if (runtimeStatus.state === 'ready') return;
    if (starbaseBootstrapInFlight) return starbaseBootstrapInFlight;

    setRuntimeStatus({ state: 'starting' });
    traceStarbase('bootstrap started');
    starbaseBootstrapInFlight = (async () => {
      try {
        await Promise.all([envReady, cliReady]);
        const fleetBinPath = await cliReady;
        traceStarbase('bootstrap prerequisites ready', { fleetBinPath, workspacePath });
        await runtimeClient.start({
          workspacePath,
          fleetBinPath,
          env: normalizeRuntimeEnv(process.env)
        });
        traceStarbase('runtime client started');

        const { starbaseId, starbaseName, sectors } = await runtimeClient.invoke<{
          starbaseId: string;
          starbaseName: string;
          sectors: Array<{ name: string; root_path: string; stack?: string; base_branch?: string }>;
        }>('runtime.getAdmiralBootstrapData');
        traceStarbase('got admiral bootstrap data', {
          starbaseId,
          starbaseName,
          sectorCount: sectors.length
        });
        const admiralWorkspace = join(
          homedir(),
          '.fleet',
          'starbases',
          `starbase-${starbaseId}`,
          'admiral'
        );
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: got admiral bootstrap data', {
          starbaseId,
          sectorCount: sectors.length,
          admiralWorkspace
        });

        admiralProcess = new AdmiralProcess({
          workspace: admiralWorkspace,
          starbaseName,
          sectors,
          ptyManager,
          fleetBinPath
        });
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: admiral process created');
        traceStarbase('admiral process created');

        admiralProcess.setOnStatusChange((status, error, exitCode) => {
          if (status === 'stopped') {
            admiralStateDetector.reset();
            admiralStateDetector.setAdmiralPaneId(null);
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.ADMIRAL_STATUS_CHANGED, {
              status,
              paneId: admiralProcess?.paneId,
              error,
              exitCode
            });
          }
        });

        socketSupervisor = new SocketSupervisor(
          SOCKET_PATH,
          createSocketRuntimeServices(runtimeClient),
          imageService
        );
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: socket supervisor created', { socketPath: SOCKET_PATH });
        traceStarbase('socket supervisor created', { socketPath: SOCKET_PATH });
        socketSupervisor.on('state-change', (event: string, data: unknown) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, { event, data });
          }
        });
        socketSupervisor.on('restarted', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
              event: 'socket:restarted',
              data: {}
            });
          }
        });
        socketSupervisor.on('failed', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.STARBASE_STATUS_UPDATE, {
              event: 'socket:failed',
              data: {}
            });
          }
        });
        socketSupervisor.on('file-open', (payload: unknown) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, payload);
          }
        });
        socketSupervisor.start().catch((err) => {
          console.error('[socket-supervisor] Failed to start:', err);
          traceStarbase('socket supervisor start failed', {
            message: err instanceof Error ? err.message : String(err)
          });
        });
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: socket supervisor start requested');
        traceStarbase('socket supervisor start requested');

        commandHandler.setRuntimeClient(runtimeClient);
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: runtime client bound to command handler');
        traceStarbase('runtime client bound to command handler');

        const initialUnread = await runtimeClient.invoke<unknown[]>('comms.getUnread', 'admiral');
        lastUnreadCommsCount = Array.isArray(initialUnread) ? initialUnread.length : 0;
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: unread comms fetched', { lastUnreadCommsCount });
        traceStarbase('unread comms fetched', { lastUnreadCommsCount });
        const initSnapshot =
          await runtimeClient.invoke<Record<string, unknown>>('starbase.snapshot');
        const initFo =
          typeof initSnapshot === 'object' && 'firstOfficer' in initSnapshot
            ? initSnapshot.firstOfficer
            : null;
        lastUnreadMemosCount = Number(
          (initFo != null && typeof initFo === 'object' && 'unreadMemos' in initFo
            ? initFo.unreadMemos
            : 0) ?? 0
        );
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: unread memos fetched', { lastUnreadMemosCount });
        traceStarbase('unread memos fetched', { lastUnreadMemosCount });
        for (const ws of layoutStore.list()) {
          layoutStore.ensureStarCommandTab(ws.id, workspacePath);
          layoutStore.ensureImagesTab(ws.id, workspacePath);
        }
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: ensured star command tab');
        traceStarbase('ensured star command tab');
        const snapshotData =
          await runtimeClient.invoke<Record<string, unknown>>('starbase.snapshot');
        await handleStarbaseSnapshot(snapshotData);
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: initial snapshot handled');
        traceStarbase('initial snapshot handled');
        setRuntimeStatus({ state: 'ready' });
        // eslint-disable-next-line no-console
        console.log('[starbase] bootstrap: ready');
        traceStarbase('bootstrap ready');
      } catch (err) {
        socketSupervisor?.stop().catch(() => {});
        admiralProcess?.stop();
        const message = err instanceof Error ? err.message : String(err);
        console.error('[starbase] Failed to initialize Star Command database:', err);
        traceStarbase('bootstrap failed', {
          message,
          stack: err instanceof Error ? err.stack : undefined
        });
        setRuntimeStatus({ state: 'error', error: message });
        throw err;
      } finally {
        starbaseBootstrapInFlight = null;
        traceStarbase('bootstrap finished');
      }
    })();

    starbaseReadyPromise = starbaseBootstrapInFlight;
    return starbaseReadyPromise;
  };

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
    () => ({
      envReady,
      cliReady,
      starbaseReady: starbaseReadyPromise,
      getRuntimeStatus: () => runtimeStatus,
      retryStarbaseBootstrap: async () => {
        try {
          await bootstrapStarbase();
        } catch {
          // status is already updated for renderer consumption
        }
        return runtimeStatus;
      }
    }),
    () => ({
      runtime: runtimeClient,
      admiralProcess,
      admiralStateDetector
    }),
    workspacePath
  );

  // Wire socket command handler to the window
  commandHandler.setWindowGetter(() => mainWindow);
  runtimeClient.on('starbase.snapshot', (snapshot) => {
    if (isRecord(snapshot)) {
      void handleStarbaseSnapshot(snapshot);
    }
  });
  runtimeClient.on('starbase.log-entry', (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.STARBASE_LOG_ENTRY, entry);
    }
  });
  runtimeClient.on('runtime.status', (status) => {
    setRuntimeStatus(status);
  });

  const startAdmiralAndWire = async (): Promise<string | null> => {
    const admiralProcessRef = admiralProcess;
    if (!admiralProcessRef) return null;
    try {
      const paneId = await admiralProcessRef.start();
      admiralStateDetector.setAdmiralPaneId(paneId);
      ptyManager.onData(paneId, (data) => {
        notificationDetector.scan(paneId, data);
        admiralStateDetector.scan(paneId, data);
        const w = mainWindow;
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId, data });
        }
      });
      cwdPoller.startPolling(paneId, ptyManager.getPid(paneId) ?? 0);
      return paneId;
    } catch (err) {
      console.error('[admiral] Failed to start:', err);
      return null;
    }
  };

  ipcMain.handle(IPC_CHANNELS.ADMIRAL_ENSURE_STARTED, async () => {
    await Promise.all([envReady, cliReady]);
    await bootstrapStarbase();
    const admiralProcessRef = admiralProcess;
    if (!admiralProcessRef) return null;
    if (admiralProcessRef.paneId) return admiralProcessRef.paneId;
    if (admiralProcessRef.status === 'starting') return null;
    return startAdmiralAndWire();
  });

  void bootstrapStarbase().catch(() => {
    // Initial bootstrap failures are surfaced through runtime status for the renderer.
  });

  imageService.resumeInterrupted();

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
    const recordCwd = 'cwd' in record && typeof record.cwd === 'string' ? record.cwd : undefined;
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

  // Forward admiral state detail changes to renderer
  eventBus.on('admiral-state-change', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.ADMIRAL_STATE_DETAIL, {
        state: event.state,
        statusText: event.statusText
      });
    }
  });

  // Forward agent state changes to renderer
  eventBus.on('agent-state-change', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_STATE, {
        states: agentTracker.getAllStates()
      });
    }
  });

  // Clean up session mapping and CWD polling when panes close
  eventBus.on('pane-closed', (event) => {
    cwdPoller.stopPolling(event.paneId);
    for (const [sessionId, paneId] of sessionToPaneMap) {
      if (paneId === event.paneId) {
        sessionToPaneMap.delete(sessionId);
        break;
      }
    }
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
    // eslint-disable-next-line no-console
    console.log('[auto-updater] status:', status.state);
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
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Auto-update check failed:', err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function shutdownAll(): void {
  ptyManager.killAll();
  cwdPoller.stopAll();
  socketSupervisor?.stop().catch((err) => console.error('[socket-supervisor] stop error:', err));
  admiralProcess?.stop();
  admiralStateDetector.dispose();
  jsonlWatcher.stop();
  runtimeClient.stop();
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
