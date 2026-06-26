import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  nativeImage,
  net,
  protocol,
  shell
} from 'electron';
import { safeOpenExternal } from './safe-external';
import { existsSync, statSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { fileURLToPath, pathToFileURL } from 'url';
import { join, dirname, resolve } from 'path';
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
import { IPC_CHANNELS, IS_FLEET_DEV, SOCKET_PATH } from '../shared/constants';
import { SocketSupervisor } from './socket-supervisor';
import { CwdPoller } from './cwd-poller';
import { installFleetCLI, installSkillFile, installOpencodePlugin } from './install-fleet-cli';
import { ImageService } from './image-service';
import { AnnotateService } from './annotate-service';
import { AnnotationStore } from './annotation-store';
import { PiAgentManager } from './pi-agent-manager';
import { PiEnvInjectionManager } from './pi-env-injection-manager';
import { EnvSyncManager } from './env-sync/env-sync-manager';
import { EnvSyncSecrets } from './env-sync/env-sync-secrets';
import { PiConfigManager } from './pi-config-manager';
import { PiAuthInspector } from './pi-auth-inspector';
import { FleetBridgeServer } from './fleet-bridge';
import { WorktreeService } from './worktree-service';
import { enrichProcessEnv } from './shell-env';
import { WslService } from './wsl-service';
import { parseFleetUrl } from './protocol-paths';
import { toWslUncPath } from '../shared/path-platform';
import { ShellProfileRegistry, defaultFileExists } from './shell-profiles';
import { resolveBootstrapWorkspacePath } from './workspace-path';
import type { HostContextPayload } from '../shared/ipc-api';
import type {
  NotificationLevel,
  UpdateStatus,
  ImageSettings,
  WorkerProfile
} from '../shared/types';
import { REVIEWER_PROFILE_NAME, DEFAULT_REVIEWER_INSTRUCTIONS } from '../shared/types';
import { getPaneTypeForFilePath, isBinaryBlockedFilePath } from '../shared/file-open';
import { randomUUID } from 'crypto';
import { createLogger } from './logger';
import { initCopilot, stopCopilot, pruneDeadCopilotSessions } from './copilot/index';
import { KanbanStore } from './kanban/kanban-store';
import { KanbanDispatcher } from './kanban/kanban-dispatcher';
import type { DispatcherConfig, WorkerExit } from './kanban/kanban-dispatcher';
import { setKanbanSettingsApplier } from './kanban/kanban-settings-bridge';
import { KanbanMcpServer } from './kanban/kanban-mcp-server';
import { PmChatService } from './kanban/pm-chat-service';
import { PmAutopilot, buildEventBriefing } from './kanban/pm-autopilot';
import { buildRetroBriefing } from './kanban/pm-retro';
import { buildDigestContext } from './kanban/pm-digest';
import { RuneFileChatService } from './rune-assist/rune-file-chat-service';
import { registerRuneAssistIpc } from './rune-assist/rune-assist-ipc';
import {
  prepareWorkspace,
  ensureFeatureBranch,
  checkoutBranchWorktree,
  worktreeDiff
} from './kanban/workspace';
import { PrPoller } from './kanban/pr-poller';
import { loadTaskDocs, pmDocsDir } from './kanban/pm-paths';
import {
  spawnRuneWorker,
  spawnVerify,
  resolveWorkProfile,
  detectAuthFailure,
  extractRuneError,
  lastLogLine
} from './kanban/spawn-worker';
import { RuneManager } from './rune-manager';
import { RuneConfigManager } from './rune-config-manager';
import { SessionsService } from './sessions/service';
import { registerSessionsIpcHandlers } from './sessions/ipc-handlers';
import { LearningsStore } from './learnings/learnings-store';
import { registerLearningsIpcHandlers } from './learnings/ipc-handlers';
import { WorkerEmbedder } from './learnings/embed-service';
import { LearningsSearchService } from './learnings/search-service';
import { LearningsMcpServer } from './learnings/learnings-mcp-server';
import {
  registerLearningsMcp,
  loadPreferredPort,
  persistPort
} from './learnings/learnings-mcp-registrar';
import { runBackfill } from './learnings/backfill';
import { RUNE_NOT_INSTALLED_MESSAGE } from '../shared/rune';
import { registerKanbanIpc } from './kanban/kanban-ipc';
import { KanbanCommands } from './kanban/kanban-commands';
import { ChatStore } from './chat/chat-store';
import { ChatSecrets } from './chat/chat-secrets';
import { OpenRouterClient } from './chat/openrouter-client';
import { ChatService } from './chat/chat-service';
import { registerChatIpc } from './chat/chat-ipc';
import { PermissionManager } from './chat/permissions/permission-manager';
import { ChatToolExecutor } from './chat/tools/tool-runner';
import { McpManager } from './chat/mcp/manager';
import { SkillManager, type SkillRoot } from './chat/skills/skill-manager';
import { ChatImageStorage } from './chat/image/image-storage';
import { OpenRouterImageProvider } from './chat/image/openrouter-image-provider';
import { KanbanNotifier } from './kanban/kanban-notifier';
import pkg from 'electron-updater';
const { autoUpdater } = pkg;

const log = createLogger('fleet-main');
const updaterLog = createLogger('auto-updater');

// Preferred loopback port for the Learnings KB MCP server. Fixed so the URL written
// into ~/.claude.json and ~/.rune/mcp.json stays stable across restarts; falls back
// to an OS-assigned port on conflict (the entry is then rewritten with the live port).
const LEARNINGS_MCP_PORT = 49823;

let mainWindow: BrowserWindow | null = null;
let socketSupervisor: SocketSupervisor | null = null;
let sessionsService: SessionsService | null = null;
let learningsStore: LearningsStore | undefined;
let learningsEmbedder: WorkerEmbedder | undefined;
let learningsMcp: LearningsMcpServer | undefined;
let kanbanStore: KanbanStore | undefined;
let kanbanMcp: KanbanMcpServer | undefined;
let kanbanDispatcher: KanbanDispatcher | undefined;
let kanbanPrPoller: PrPoller | undefined;
let kanbanCommands: KanbanCommands | undefined;
let kanbanNotifier: KanbanNotifier | null = null;
let pmChat: PmChatService | undefined;
let pmAutopilot: PmAutopilot | undefined;
let pmDigestTimer: ReturnType<typeof setInterval> | undefined;
let runeAssist: RuneFileChatService | null = null;

function requireKanbanStore(): KanbanStore {
  if (!kanbanStore) throw new Error('kanban store not initialized');
  return kanbanStore;
}

function requireKanbanCommands(): KanbanCommands {
  if (!kanbanCommands) throw new Error('kanban commands not initialized');
  return kanbanCommands;
}

const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();
const settingsStore = new SettingsStore();
const notificationDetector = new NotificationDetector(eventBus);
const notificationState = new NotificationStateManager(eventBus);
const activityTracker = new ActivityTracker(eventBus, {
  silenceThresholdMs: 5000,
  processPollingIntervalMs: 2000,
  getProcessName: (paneId) => ptyManager.getProcessName(paneId)
});
const cwdPoller = new CwdPoller(eventBus, ptyManager);
const imageService = new ImageService();
const ANNOTATIONS_DIR = join(homedir(), '.fleet', 'annotations');
const annotationStore = new AnnotationStore(ANNOTATIONS_DIR);
const annotateService = new AnnotateService(annotationStore);
const piAgentManager = new PiAgentManager();
const runeManager = new RuneManager();
const runeConfigManager = new RuneConfigManager();
const piConfigManager = new PiConfigManager();
const piEnvInjectionManager = new PiEnvInjectionManager();
const envSyncSecrets = new EnvSyncSecrets();
const envSyncManager = new EnvSyncManager({ secrets: envSyncSecrets });
const piAuthInspector = new PiAuthInspector({
  modelCatalogPath: join(
    homedir(),
    '.fleet',
    'agents',
    'pi',
    'node_modules',
    '@mariozechner',
    'pi-ai',
    'dist',
    'index.js'
  )
});
const fleetBridge = new FleetBridgeServer();
const wslService = new WslService();
const shellProfileRegistry = new ShellProfileRegistry({
  platform: process.platform,
  env: process.env,
  wslService,
  fileExists: defaultFileExists
});
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
// In dev mode (FLEET_DEV=1), skip the lock so dev and production can coexist.
if (!IS_FLEET_DEV) {
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
}

// Register fleet-image:// protocol to serve local images without base64 IPC overhead
protocol.registerSchemesAsPrivileged([
  { scheme: 'fleet-image', privileges: { supportFetchAPI: true, stream: true } },
  { scheme: 'fleet-pdf', privileges: { supportFetchAPI: true, stream: true } },
  {
    scheme: 'fleet-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
]);

void app.whenReady().then(async () => {
  // Resolve a fleet-image/fleet-pdf request URL to a filesystem-accessible
  // absolute path. The renderer's canonical builder puts the path in the URL path
  // position (empty authority); legacy call sites still emit backslash shapes that
  // make `new URL` throw, so parseFleetUrl parses by hand. A bare POSIX path is a
  // native path on macOS/Linux (served directly); only under win32 does a
  // distro-less POSIX path need the default-distro WSL UNC bridge.
  const resolveFleetPath = async (rawUrl: string, scheme: string): Promise<string | null> => {
    const parsed = parseFleetUrl(rawUrl, scheme);
    if (!parsed) return null;
    if (parsed.kind === 'win') return parsed.path;
    if (process.platform !== 'win32') return parsed.posixPath;
    const distros = await wslService.listDistros();
    const distro = distros.find((d) => d.isDefault)?.name ?? distros[0]?.name;
    return distro ? toWslUncPath(distro, parsed.posixPath) : null;
  };

  const isUncPath = (p: string): boolean => p.startsWith('\\\\') || p.startsWith('//');

  const IMAGE_MIME: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    avif: 'image/avif',
    ico: 'image/x-icon'
  };

  protocol.handle('fleet-image', async (request) => {
    const filePath = await resolveFleetPath(request.url, 'fleet-image');
    if (!filePath) return new Response('Bad Request', { status: 400 });
    // Node `fs` reads the WSL 9P UNC share natively; net.fetch is unreliable for
    // UNC, so readFile+Response is the primary path there. Plain drive/POSIX
    // paths keep the streaming net.fetch path.
    if (isUncPath(filePath)) {
      try {
        const data = await readFile(filePath);
        const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
        return new Response(new Uint8Array(data), {
          headers: { 'Content-Type': IMAGE_MIME[ext] ?? 'application/octet-stream' }
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Serve local PDFs to the bundled pdf.js viewer (fetch works through custom
  // schemes even though Chromium's native PDF viewer does not on Electron 39).
  protocol.handle('fleet-pdf', async (request) => {
    const resolved = await resolveFleetPath(request.url, 'fleet-pdf');
    if (!resolved) return new Response('Bad Request', { status: 400 });
    // resolve() normalizes any `..` segments so the .pdf suffix check is a
    // meaningful guard, not bypassable via traversal.
    const filePath = resolve(resolved);
    if (!filePath.toLowerCase().endsWith('.pdf')) {
      return new Response('Forbidden', { status: 403 });
    }
    if (isUncPath(filePath)) {
      try {
        const data = await readFile(filePath);
        return new Response(new Uint8Array(data), {
          headers: { 'Content-Type': 'application/pdf' }
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Serve static assets from resources/ directory (mascot sprites, etc.)
  protocol.handle('fleet-asset', async (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.hostname + url.pathname);

    // Prevent path traversal
    if (relativePath.includes('..')) {
      return new Response('Forbidden', { status: 403 });
    }

    const resourcesDir = app.isPackaged
      ? join(process.resourcesPath, 'resources')
      : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources');

    const filePath = join(resourcesDir, relativePath);

    try {
      const data = await readFile(filePath);
      const ext = relativePath.split('.').pop()?.toLowerCase() ?? '';
      const mime: Record<string, string> = {
        webp: 'image/webp',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        svg: 'image/svg+xml'
      };
      return new Response(data, {
        headers: { 'Content-Type': mime[ext] ?? 'application/octet-stream' }
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  createWindow();

  const gitService = new GitService();
  const workspacePath = resolveBootstrapWorkspacePath({
    cwd: process.cwd(),
    pwd: process.env.PWD,
    isPackaged: app.isPackaged
  });
  void enrichProcessEnv();
  void installSkillFile().catch((err) => {
    log.warn('failed to install skill file', {
      error: err instanceof Error ? err.message : String(err)
    });
  });
  void installOpencodePlugin().catch((err) => {
    log.warn('failed to install opencode plugin', {
      error: err instanceof Error ? err.message : String(err)
    });
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
    new WorktreeService(),
    annotationStore,
    annotateService,
    piAgentManager,
    runeManager,
    runeConfigManager,
    fleetBridge,
    piConfigManager,
    piAuthInspector,
    piEnvInjectionManager,
    shellProfileRegistry,
    wslService,
    envSyncManager,
    envSyncSecrets
  );

  imageService.resumeInterrupted();

  // Clean up old annotations based on retention settings
  const retentionDays = settingsStore.get().annotate.retentionDays;
  annotationStore.cleanup(retentionDays);

  // Forward annotation changes to renderer
  annotationStore.on('changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.ANNOTATE_COMPLETED);
    }
  });

  // Start socket server for fleet CLI (images + open commands)
  socketSupervisor = new SocketSupervisor(
    SOCKET_PATH,
    imageService,
    annotateService,
    () => kanbanCommands
  );
  socketSupervisor.on('file-open', (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, payload);
    }
  });
  socketSupervisor.on('pi-open', (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PI_OPEN, payload);
    }
  });
  socketSupervisor.on('pi-plan-open', (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.PI_PLAN_OPEN, payload);
    }
  });
  socketSupervisor.start().catch((err: unknown) => {
    log.error('socket-supervisor failed to start', {
      error: err instanceof Error ? err.message : String(err)
    });
  });

  // Start Fleet bridge for Pi agent extensions
  fleetBridge.onRequest(async (type, payload, paneId) => {
    await Promise.resolve();
    switch (type) {
      case 'file.open': {
        const rawPath = typeof payload.path === 'string' ? payload.path : '';
        if (!rawPath) throw new Error('file.open requires a path');

        const filePath = resolve(rawPath);
        if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
        if (statSync(filePath).isDirectory()) {
          throw new Error(`directories not supported, use a file path: ${filePath}`);
        }
        if (isBinaryBlockedFilePath(filePath)) {
          throw new Error(`unsupported binary file: ${filePath}`);
        }

        const paneType = getPaneTypeForFilePath(filePath);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, {
            files: [{ path: filePath, paneType, label: filePath.split('/').pop() ?? filePath }]
          });
        }
        return { ok: true, paneType };
      }
      case 'pi.plan_open': {
        const rawPath = typeof payload.path === 'string' ? payload.path : '';
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : undefined;
        if (!rawPath) throw new Error('pi.plan_open requires a path');

        const planPath = resolve(rawPath);
        if (!existsSync(planPath)) throw new Error(`file not found: ${planPath}`);
        if (statSync(planPath).isDirectory()) {
          throw new Error(`directories not supported, use a file path: ${planPath}`);
        }
        if (isBinaryBlockedFilePath(planPath)) {
          throw new Error(`unsupported binary file: ${planPath}`);
        }

        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_CHANNELS.PI_PLAN_OPEN, {
            path: planPath,
            paneId,
            requestId
          });
        }
        return { ok: true };
      }
      default:
        throw new Error(`Unknown bridge command: ${type}`);
    }
  });
  fleetBridge.start().catch((err: unknown) => {
    log.error('Fleet bridge failed to start', {
      error: err instanceof Error ? err.message : String(err)
    });
  });

  // Start copilot (macOS only, gated internally)
  await initCopilot(settingsStore, ptyManager, layoutStore, () => mainWindow);

  // Set dock icon on macOS — must happen AFTER copilot init because the copilot
  // window's setVisibleOnAllWorkspaces triggers an Electron bug (electron/electron#26350)
  // that resets the dock entry.
  if (process.platform === 'darwin') {
    const dockIconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png');
    const dockIcon = nativeImage.createFromPath(dockIconPath);
    if (!dockIcon.isEmpty()) {
      app.dock?.setIcon(dockIcon);
      log.info('dock icon set');
    }
  }

  // Clean up CWD polling and activity tracking when panes close
  eventBus.on('pane-closed', (event) => {
    cwdPoller.stopPolling(event.paneId);
    activityTracker.untrackPane(event.paneId);
    // Give child processes time to die after PTY shell is killed, then prune
    setTimeout(() => pruneDeadCopilotSessions(), 500);
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
        timestamp: event.timestamp
      });
    }
  });

  // Forward remote-session changes (ssh/mosh/…) to renderer via IPC
  eventBus.on('remote-session-change', (event) => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.REMOTE_STATE, {
        paneId: event.paneId,
        remote: event.remote
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

    piAgentManager.checkForUpdates().catch((err: unknown) => {
      log.warn('pi agent update check failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }

  // Bootstrap kanban subsystem
  const KANBAN_HOME = join(homedir(), '.fleet', 'kanban');
  const verifyLogPath = (runId: number): string => join(KANBAN_HOME, 'logs', `verify-${runId}.log`);
  kanbanStore = new KanbanStore(join(KANBAN_HOME, 'kanban.db'), {
    onEvent: (event) => {
      const w = mainWindow;
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.KANBAN_EVENT, event);
      }
      socketSupervisor?.broadcastKanbanEvent(event);
      kanbanNotifier?.enqueue(event);
      pmAutopilot?.onEvent(event);
    },
    onBoardsChanged: () => {
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.send(IPC_CHANNELS.KANBAN_BOARDS_CHANGED);
      }
    }
  });
  kanbanNotifier = new KanbanNotifier({
    isOsEnabled: (category) => settingsStore.get().kanban.notifications[category].os,
    isAutoReviewOn: () => settingsStore.get().kanban.dispatcher.autoReview,
    getTask: (taskId) => {
      const t = kanbanStore?.getTask(taskId);
      return t ? { title: t.title, boardId: t.boardId } : null;
    },
    getFeature: (featureId) => {
      const f = kanbanStore?.getFeature(featureId);
      return f ? { name: f.name, boardId: f.boardId } : null;
    },
    present: ({ body, boardSlug, taskId }) => {
      if (!Notification.isSupported()) return;
      const notif = new Notification({ title: 'Fleet — Kanban', body });
      notif.on('click', () => {
        mainWindow?.show();
        mainWindow?.focus();
        mainWindow?.webContents.send(IPC_CHANNELS.KANBAN_FOCUS_TASK, { boardSlug, taskId });
      });
      notif.show();
    }
  });
  kanbanMcp = new KanbanMcpServer(kanbanStore, () => settingsStore.get().kanban.profiles);
  const kanbanMcpPort = await kanbanMcp.start(0);

  const kanbanMcpRef = kanbanMcp;
  // A worker that dies this soon after spawn never did real work — treat such a
  // crash as a deterministic startup failure (block now) rather than retrying.
  const KANBAN_STARTUP_CRASH_MS = 10_000;
  // How each worker process exited, keyed by runId. Lets reclaim() tell a clean
  // "ended turn without completing" (rune exit 3) apart from a crash. Pruned as
  // soon as reclaim consumes an entry; entries are only recorded for runs that
  // hadn't already reached a terminal state, so normal completions never linger.
  const workerExits = new Map<number, WorkerExit>();
  const buildDispatcherConfig = (): DispatcherConfig => {
    const d = settingsStore.get().kanban.dispatcher;
    return {
      failureLimit: d.failureLimit,
      claimGraceMs: 120_000, // internal grace window; not user-configurable
      maxInProgress: d.maxInProgress,
      claimTtlMs: d.claimTtlMs,
      autoDecompose: d.autoDecompose,
      autoAssign: d.autoAssign,
      autoIntegrate: d.autoIntegrate,
      autoReview: d.autoReview,
      maxDecompose: d.maxDecompose,
      artifactRetentionDays: settingsStore.get().kanban.artifactRetentionDays
    };
  };
  kanbanDispatcher = new KanbanDispatcher(kanbanStore, {
    now: Date.now,
    workerProfileNames: () =>
      settingsStore
        .get()
        .kanban.profiles.filter((p) => p.role === 'worker')
        .map((p) => p.name),
    profileRoles: () => settingsStore.get().kanban.profiles.map((p) => p.role),
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    prepareWorkspaceFn: (task) => {
      // A feature_sync system task must check out the integration branch ITSELF (no new
      // -b branch), so its resolve run merges main into the real integration branch.
      if (
        task.systemKind === 'feature_sync' &&
        task.workspaceKind === 'worktree' &&
        task.repoPath &&
        task.branchName &&
        task.workspacePath == null
      ) {
        const wt = checkoutBranchWorktree({
          repoPath: task.repoPath,
          branchName: task.branchName,
          worktreesRoot: join(KANBAN_HOME, 'worktrees'),
          taskId: task.id
        });
        requireKanbanStore().setWorkspace(task.id, wt.path, wt.branchName, task.baseBranch ?? null);
        return wt.path;
      }
      // A worktree task in a feature branches off the feature's integration branch
      // (`fleet/feature-<id>`), created on first use. The captured base then cascades:
      // the task merges back into integration, and decompose children inherit it.
      let featureStartPoint: string | undefined;
      if (
        task.featureId &&
        task.workspaceKind === 'worktree' &&
        task.repoPath &&
        task.workspacePath == null
      ) {
        const feature = requireKanbanStore().getFeature(task.featureId);
        if (feature) {
          const integrationBranch = feature.integrationBranch ?? `fleet/feature-${feature.id}`;
          const ensured = ensureFeatureBranch({
            repoPath: task.repoPath,
            integrationBranch,
            baseBranch: feature.baseBranch ?? undefined
          });
          if (!ensured.ok) {
            // Fail fast: silently falling back to repo HEAD would merge this
            // feature task into main instead of its integration branch. The
            // dispatcher turns this into a visible spawn_failed for the task.
            throw new Error(`feature integration branch setup failed: ${ensured.error}`);
          }
          featureStartPoint = integrationBranch;
          if (!feature.integrationBranch) {
            requireKanbanStore().updateFeature(feature.id, {
              integrationBranch,
              mergeState: 'pending'
            });
          }
        }
      }
      const prepared = prepareWorkspace({
        kind: task.workspaceKind,
        taskId: task.id,
        workspacesRoot: join(KANBAN_HOME, 'workspaces'),
        worktreesRoot: join(KANBAN_HOME, 'worktrees'),
        workspacePath: task.workspacePath ?? undefined,
        repoPath: task.repoPath ?? undefined,
        branchName: task.branchName ?? undefined,
        // A dependent child branches from its parent's base so it inherits the
        // parent's merged work; a feature task branches off its integration branch;
        // top-level tasks fall back to the repo's HEAD.
        startPoint: task.baseBranch ?? featureStartPoint ?? undefined
      });
      // Persist the workspace path for worktree AND scratch tasks so the artifact MCP handler,
      // archive warning, and reveal/discard actions all resolve the same durable path.
      if (
        (task.workspaceKind === 'worktree' || task.workspaceKind === 'scratch') &&
        task.workspacePath == null
      ) {
        requireKanbanStore().setWorkspace(
          task.id,
          prepared.path,
          prepared.branchName,
          prepared.baseBranch
        );
      }
      return prepared.path;
    },
    spawnWorker: ({ task, runId, lock, workspace, mode, verifyFailure, reviewFindings }) => {
      // Pre-flight gate: if we already know rune is missing, fail fast with a clear, actionable
      // reason. This routes through the dispatcher's catch → spawn_failed (shown in the drawer)
      // instead of letting the worker die and surface as a cryptic "pid not alive" reclaim.
      if (runeManager.isInstalledCached() === false) {
        throw new Error(RUNE_NOT_INSTALLED_MESSAGE);
      }
      const runToken = randomUUID();
      kanbanMcpRef.registerRun(runToken, { kind: 'task', taskId: task.id, runId, mode }, lock);
      const profiles = settingsStore.get().kanban.profiles;
      let profile: WorkerProfile | null;
      let roster: Array<{ name: string; description: string }> | undefined;
      let reviewDiff: string | undefined;
      if (mode === 'work' || mode === 'resolve') {
        const resolved = resolveWorkProfile(profiles, task.assignee);
        profile = resolved.profile;
        if (resolved.fellBack) {
          log.warn('kanban: non-worker profile assigned to work task; using worker fallback', {
            taskId: task.id,
            assignee: task.assignee,
            fallback: profile?.name ?? null
          });
        }
      } else if (mode === 'review') {
        // Singleton reviewer selected BY MODE; fall back to an in-memory default persona when
        // no saved reviewer profile exists (existing users have none). NEVER write task.assignee.
        const reviewerProfile = profiles.find(
          (p) => p.name === REVIEWER_PROFILE_NAME && p.role === 'reviewer'
        );
        profile = reviewerProfile ?? {
          name: REVIEWER_PROFILE_NAME,
          role: 'reviewer',
          model: '',
          skills: [],
          instructions: DEFAULT_REVIEWER_INSTRUCTIONS
        };
        reviewDiff = worktreeDiff({ workspacePath: workspace, baseBranch: task.baseBranch });
      } else if (mode === 'explore' || mode === 'spec' || mode === 'qa') {
        // Pipeline stage roles run under their own persona, selected by the assignee the
        // expander stamped on the task ('explorer'/'architect'/'qa'). NEVER overwrite the
        // assignee and offer NO worker roster — these are single-role runs, not orchestrations.
        profile = profiles.find((p) => p.name === task.assignee) ?? null;
      } else {
        // decompose/specify: run as an orchestrator profile; offer the worker roster.
        profile =
          profiles.find((p) => p.role === 'orchestrator') ??
          profiles.find((p) => p.name === 'orchestrator') ??
          null;
        roster = profiles
          .filter((p) => p.role === 'worker')
          .map((p) => ({
            name: p.name,
            description: (p.instructions.split('\n')[0] ?? '').slice(0, 120)
          }));
        // Record the orchestrator as the task's assignee so the triage card reflects who is
        // running it. The dispatcher never sets this for decompose/specify runs (it only writes
        // task_runs.profile), leaving the card unassigned otherwise.
        // decompose/specify record the orchestrator as the card's assignee; an assign run
        // must not — it exists precisely to choose and set the real assignee itself.
        if (mode !== 'assign') {
          requireKanbanStore().updateTask(task.id, {
            assignee: profile?.name ?? 'orchestrator'
          });
        }
      }
      let resolveTarget: string | undefined;
      if (mode === 'resolve') {
        if (task.systemKind === 'feature_sync') {
          resolveTarget = task.baseBranch ?? undefined; // system task's branch IS the integration branch; merge base in
        } else if (task.featureId) {
          const f = requireKanbanStore().getFeature(task.featureId);
          resolveTarget = f ? (f.integrationBranch ?? `fleet/feature-${f.id}`) : undefined;
        } else {
          resolveTarget = task.baseBranch ?? undefined;
        }
      }
      const logPath = join(KANBAN_HOME, 'logs', `${runToken}.log`);
      const spawnedAt = Date.now();
      return spawnRuneWorker(
        {
          task: {
            id: task.id,
            title: task.title,
            body: task.body,
            assignee: task.assignee,
            modelOverride: task.modelOverride
          },
          workspace,
          resolveTarget,
          verifyFailure,
          reviewDiff,
          reviewFindings,
          mcpPort: kanbanMcpPort,
          runToken,
          logPath,
          mode,
          profile,
          roster,
          attachments: requireKanbanStore()
            .listAttachments(task.id)
            .map((a) => ({
              filename: a.filename,
              storedPath: a.storedPath
            })),
          docs: loadTaskDocs(pmDocsDir(KANBAN_HOME, task.boardId), task.docs)
        },
        // ENOENT here means rune vanished from PATH after our cached check. Mark it missing so
        // the next claim is guarded up-front with the clear reason above.
        (err) => {
          if (err.code === 'ENOENT') runeManager.markMissing();
        },
        // Record the exit only if the run didn't already finish via an MCP
        // terminal call (kanban_complete/block move the task off 'running').
        // That keeps the map to in-flight-but-exited runs and lets reclaim()
        // classify rune's exit-3 "incomplete" without false-flagging successes.
        (exit) => {
          const t = requireKanbanStore().getTask(task.id);
          if (t?.status !== 'running' || t.currentRunId !== runId) return;
          // Classify the cause of death while the log path is in scope, so the
          // dispatcher can surface the real error and block retry-proof failures
          // instead of looping on a cryptic "pid not alive" reclaim.
          const authFailed = detectAuthFailure(logPath);
          const runeError = extractRuneError(logPath);
          const crashed = (exit.code != null && exit.code !== 0) || exit.signal != null;
          const startupCrash = crashed && Date.now() - spawnedAt < KANBAN_STARTUP_CRASH_MS;
          let fatalReason: string | undefined;
          let blockNow = false;
          if (authFailed) {
            fatalReason = `rune authentication failed${runeError ? `: ${runeError}` : ''} — fix the provider credentials (e.g. \`rune login\`) and retry`;
            blockNow = true;
          } else if (runeError) {
            // A provider/runtime error (e.g. a 4xx). Surface it; only block now if
            // it also died on startup — otherwise let the retry budget absorb transients.
            fatalReason = runeError;
            blockNow = startupCrash;
          } else if (startupCrash) {
            const line = lastLogLine(logPath);
            fatalReason = `worker crashed on startup${line ? `: ${line}` : ''}`;
            blockNow = true;
          }
          workerExits.set(runId, { ...exit, fatalReason, blockNow });
        }
      );
    },
    config: buildDispatcherConfig(),
    intervalMs: settingsStore.get().kanban.dispatcher.intervalMs,
    workerExit: (id) => workerExits.get(id),
    clearWorkerExit: (id) => workerExits.delete(id),
    verifyLogPath
  });
  kanbanDispatcher.start();
  // Poll GitHub PR status out-of-band (a gh network call inside the 5s dispatch
  // tick would stall task claiming).
  kanbanPrPoller = new PrPoller(kanbanStore, { now: Date.now });
  kanbanPrPoller.start();
  kanbanCommands = new KanbanCommands(
    kanbanStore,
    kanbanDispatcher,
    () => {
      const d = settingsStore.get().kanban.defaults;
      return { workspaceKind: d.workspaceKind, maxRuntimeSeconds: d.maxRuntimeSeconds };
    },
    () => settingsStore.get().kanban.profiles
  );
  kanbanMcp.setSwarmHandler((input) => requireKanbanCommands().createSwarm(input));
  kanbanMcp.setCommands(kanbanCommands);
  kanbanMcp.setKanbanHome(KANBAN_HOME);
  kanbanMcp.setVerifyRunner(({ runId, taskId, workspace, commands }) => {
    const logPath = verifyLogPath(runId);
    return spawnVerify({ workspace, commands, logPath }, (exit) => {
      // Raw recorder: NO rune auth/crash classification (a test exit-3 or a "401" in
      // output must not be misread as a fatal block). Same running/currentRunId guard as
      // the rune recorder so a late exit (after reclaim already fail-opened) can't leave a
      // stale entry.
      const t = kanbanStore!.getTask(taskId);
      if (t?.status !== 'running' || t.currentRunId !== runId) return;
      workerExits.set(runId, { code: exit.code, signal: exit.signal });
    });
  });
  pmChat = new PmChatService({
    mcp: kanbanMcp,
    mcpPort: kanbanMcpPort,
    kanbanHome: KANBAN_HOME,
    getProjects: (boardId) => requireKanbanCommands().listProjects(boardId),
    isAutopilotEnabled: () => settingsStore.get().kanban.pm.autopilotEnabled,
    emitStatus: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.KANBAN_PM_STATUS, payload);
      }
    },
    emitTranscript: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.KANBAN_PM_TRANSCRIPT, payload);
      }
    }
  });
  pmAutopilot = new PmAutopilot({
    now: () => Date.now(),
    getConfig: () => settingsStore.get().kanban.pm,
    getBoardForTask: (id) =>
      kanbanStore?.getTask(id)?.boardId ?? kanbanStore?.getFeature(id)?.boardId ?? null,
    runTurn: async (boardId, prompt, origin) => {
      await pmChat?.runTurn(boardId, prompt, origin);
    },
    buildBriefing: (events) =>
      buildEventBriefing(
        events,
        (id) => kanbanStore?.getTask(id)?.title ?? kanbanStore?.getFeature(id)?.name ?? null
      ),
    buildRetro: (featureId) => {
      const store = kanbanStore;
      if (!store) return null;
      const feature = store.getFeature(featureId);
      if (!feature) return null;
      const tasks = store.listFeatureTasks(featureId);
      return buildRetroBriefing(
        feature,
        tasks,
        (id) => store.listRuns(id),
        (id) => store.listEvents(id)
      );
    },
    log: (msg, meta) => log.warn(msg, meta ?? {}),
    listDigestBoards: () =>
      (kanbanStore?.listBoards() ?? []).map((b) => {
        const cfg = kanbanStore?.getDigestConfig(b.slug);
        return {
          boardId: b.slug,
          digestCron: cfg?.digestCron ?? null,
          lastDigestAt: cfg?.lastDigestAt ?? null
        };
      }),
    // The standup digest summarizes task-level activity (completed/blocked/failure).
    // Feature-level events (e.g. feature_pr_ready) are intentionally NOT bucketed here;
    // they surface as real-time PM event turns via buildBriefing/getBoardForTask instead.
    buildDigest: (boardId, since) =>
      buildDigestContext({
        events: kanbanStore?.listBoardEventsSince(boardId, since) ?? [],
        pendingProposals: kanbanStore?.listProposals(boardId, { status: 'pending' }).length ?? 0,
        resolveTitle: (id) => kanbanStore?.getTask(id)?.title ?? null
      }),
    stampDigest: (boardId) => kanbanStore?.stampLastDigest(boardId)
  });
  // Drive digest scheduling at cron's 1-minute granularity. stamp-before-run in
  // checkDigests makes piggybacking on a coarse tick safe (no double-fire).
  pmDigestTimer = setInterval(() => void pmAutopilot?.checkDigests(), 60_000);
  registerKanbanIpc(kanbanCommands, pmChat);

  const chatStore = new ChatStore(join(app.getPath('userData'), 'chat.db'));
  const chatSecrets = new ChatSecrets();
  const chatClient = new OpenRouterClient();
  const chatImageStorage = new ChatImageStorage(join(app.getPath('userData'), 'chat-images'));
  const chatImageProvider = new OpenRouterImageProvider(() => chatSecrets.getKey());
  const chatEmit = (channel: string, payload: unknown): void => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  const chatPermissions = new PermissionManager({
    getRules: () => settingsStore.get().ai.chat.permissions,
    persistAllowRule: (rule) => {
      const current = settingsStore.get().ai.chat.permissions;
      if (current.allow.includes(rule)) return;
      settingsStore.set({
        ai: { chat: { permissions: { ...current, allow: [...current.allow, rule] } } }
      });
    },
    emit: chatEmit
  });
  const chatMcp = new McpManager(() => settingsStore.get().ai.chat.mcpServers);
  void chatMcp.reload();
  const skillsResourcesDir = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources');
  const personalSkillsDir = join(app.getPath('userData'), 'chat-skills');
  const chatSkills = new SkillManager(
    () => {
      const roots: SkillRoot[] = [
        { root: join(skillsResourcesDir, 'pi-skills'), scope: 'bundled' },
        { root: personalSkillsDir, scope: 'personal' }
      ];
      const ws = settingsStore.get().ai.chat.tools.workspaceDir;
      if (ws) roots.push({ root: join(ws, '.claude', 'skills'), scope: 'project' });
      return roots;
    },
    () => settingsStore.get().ai.chat.skills
  );
  chatSkills.rescan();
  const chatToolExecutor = new ChatToolExecutor(
    chatPermissions,
    () => settingsStore.get().ai.chat.tools,
    chatEmit,
    chatMcp,
    (entry) => chatStore.addAudit(entry)
  );
  const chatService = new ChatService({
    store: chatStore,
    client: chatClient,
    secrets: chatSecrets,
    getDefaultModel: () => settingsStore.get().ai.chat.defaultModel,
    getImageModel: () => settingsStore.get().ai.chat.imageModel,
    getNaming: () => {
      const c = settingsStore.get().ai.chat;
      return {
        enabled: c.autoName,
        model: c.taskModel ?? c.defaultModel,
        timing: c.namingTiming
      };
    },
    getToolsMode: () => settingsStore.get().ai.chat.tools.mode,
    getMcpToolDefs: () => chatMcp.getToolDefs(),
    skills: chatSkills,
    toolExecutor: chatToolExecutor,
    imageProvider: chatImageProvider,
    imageStorage: chatImageStorage,
    emit: chatEmit
  });
  registerChatIpc({
    store: chatStore,
    secrets: chatSecrets,
    service: chatService,
    settingsStore,
    permissions: chatPermissions,
    mcp: chatMcp,
    skills: chatSkills,
    revealSkillsFolder: () => {
      mkdirSync(personalSkillsDir, { recursive: true });
      void shell.openPath(personalSkillsDir);
    }
  });

  runeAssist = new RuneFileChatService({
    stateDir: app.getPath('userData'),
    emitStatus: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.RUNE_ASSIST_STATUS, payload);
      }
    },
    emitResult: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.RUNE_ASSIST_RESULT, payload);
      }
    }
  });
  registerRuneAssistIpc(runeAssist);

  sessionsService = new SessionsService();
  registerSessionsIpcHandlers(sessionsService);

  const learningsHome = join(homedir(), '.fleet', 'learnings');
  const learningsModelDir = join(learningsHome, 'models');
  const learningsStoreRef = new LearningsStore(join(learningsHome, 'learnings.db'));
  kanbanMcp?.setLearningsStore(learningsStoreRef);
  const learningsEmbedderRef = new WorkerEmbedder({ modelCacheDir: learningsModelDir });
  learningsStore = learningsStoreRef;
  learningsEmbedder = learningsEmbedderRef;
  const learningsSearch = new LearningsSearchService(learningsStoreRef, learningsEmbedderRef);
  registerLearningsIpcHandlers(
    learningsStoreRef,
    sessionsService,
    learningsSearch,
    learningsEmbedderRef,
    learningsModelDir
  );
  // Expose the KB to Rune + Claude Code over a loopback MCP server, then register it
  // in their global configs and backfill embeddings for existing learnings.
  learningsMcp = new LearningsMcpServer(learningsStoreRef, learningsSearch);
  learningsMcp
    .start(loadPreferredPort(LEARNINGS_MCP_PORT))
    .then(async (port) => {
      // Register first, then persist: the port file is what the next launch prefers,
      // so only record it once the configs pointing at that port are written, keeping
      // the port file and the registered configs from diverging.
      registerLearningsMcp(port);
      // Remember the bound port so a forced OS-fallback (default port busy) stays
      // stable next launch instead of rewriting the global configs each time.
      persistPort(port);
      await runBackfill(learningsStoreRef, learningsEmbedderRef);
    })
    .catch((err: unknown) =>
      log.error('learnings MCP startup failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    );
  sessionsService.startWatching(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.SESSIONS_CHANGED);
    }
  });

  setKanbanSettingsApplier(() => {
    kanbanDispatcher?.reconfigure(
      buildDispatcherConfig(),
      settingsStore.get().kanban.dispatcher.intervalMs
    );
  });

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
  sessionsService?.dispose();
  annotateService.destroy();
  kanbanDispatcher?.stop();
  kanbanPrPoller?.stop();
  if (pmDigestTimer) clearInterval(pmDigestTimer);
  pmAutopilot?.dispose();
  pmChat?.dispose();
  runeAssist?.dispose();
  void kanbanMcp?.stop();
  void learningsMcp?.stop();
  void learningsEmbedder?.close();
  learningsStore?.close();
  kanbanStore?.close();
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

// Last-resort capture for errors that escape every try/catch so they land in
// ~/.fleet/logs/ instead of only an OS crash dump. Registering this handler
// overrides Electron's default (print stack + exit) — we deliberately log and
// keep running rather than tearing down the user's running terminals/agents.
process.on('uncaughtException', (err) => {
  log.error('uncaughtException', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  });
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined
  });
});
