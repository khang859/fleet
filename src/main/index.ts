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
import { safeOpenExternal, isSafeExternalUrl } from './safe-external';
import { existsSync, statSync, mkdirSync, writeFileSync } from 'fs';
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
import { ReportedActivity } from './reported-activity';
import { routeActivityReport } from './activity-report';
import {
  attentionOf,
  alertsFor,
  channelsKeyFor,
  VisiblePanesSchema,
  ActivityReportSchema
} from '../shared/attention';
import { registerIpcHandlers } from './ipc-handlers';
import { GitService } from './git-service';
import { SettingsStore } from './settings-store';
import { IPC_CHANNELS, IS_FLEET_DEV, SOCKET_PATH } from '../shared/constants';
import { deriveDebugPort, sessionFilePath, type DriveSession } from '../shared/drive-session';
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
import type { NotificationLevel, UpdateStatus, ImageSettings } from '../shared/types';
import { getPaneTypeForFilePath, isBinaryBlockedFilePath } from '../shared/file-open';
import { createLogger } from './logger';
import { initCopilot, stopCopilot, pruneDeadCopilotSessions } from './copilot/index';
import { RuneFileChatService } from './rune-assist/rune-file-chat-service';
import { registerRuneAssistIpc } from './rune-assist/rune-assist-ipc';
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
import { ChatStore } from './chat/chat-store';
import { ChatSecrets } from './chat/chat-secrets';
import { OpenRouterClient } from './chat/openrouter-client';
import { ChatService } from './chat/chat-service';
import { ChatSearchService } from './chat/chat-search-service';
import { runChatBackfill } from './chat/chat-backfill';
import { registerChatIpc } from './chat/chat-ipc';
import { registerAgentIpc } from './agent/agent-ipc';
import { AgentModelCatalog } from './agent/models-catalog';
import { AgentService } from './agent/agent-service';
import { AgentSessionStore } from './agent/session-store';
import { AGENT_ATTACHMENTS_DIR, AgentImageStore } from './agent/image-store';
import { PermissionGate } from './agent/permissions/gate';
import { AgentGitWatcher } from './agent/git-watch';
import { AgentHistoryStore } from './agent/history-store';
import { McpManager as AgentMcpManager } from './agent/mcp/manager';
import { AgentMcpSecrets } from './agent/mcp/secrets';
import { resolveAuth, signIn as signInToMcp } from './agent/mcp/auth';
import { registerRemoteSshIpcHandlers } from './remote-ssh/ipc-handlers';
import { resolveSummary } from './chat/pane-summarizer';
import { PermissionManager } from './chat/permissions/permission-manager';
import {
  ChatToolExecutor,
  type WebSearchRunner,
  type WebFetchRunner
} from './chat/tools/tool-runner';
import { createWebSearchProvider, formatWebSearchResults } from './chat/web-search';
import { extractContent, capResult } from './chat/web-fetch';
import { renderPage } from './chat/web-fetch-render';
import { McpManager } from './chat/mcp/manager';
import { SkillManager, type SkillRoot } from './chat/skills/skill-manager';
import { ChatImageStorage } from './chat/image/image-storage';
import { ChatWorkspace } from './chat/chat-workspace';
import { OpenRouterImageProvider } from './chat/image/openrouter-image-provider';
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
let agentService: AgentService | null = null;
let agentMcp: AgentMcpManager | undefined;
let runeAssist: RuneFileChatService | null = null;

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
const reportedActivity = new ReportedActivity();
/**
 * The panes the user can currently see, as the renderer last described them.
 *
 * Only the renderer knows this - it owns the tabs and the splits - and only
 * main knows whether the window is focused. An alert is chosen from both, so
 * the two halves have to meet, and this is the half that travels.
 */
let visiblePaneIds = new Set<string>();
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
      nodeIntegration: false,
      backgroundThrottling: !IS_FLEET_DEV
    },
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: '#090a0d', symbolColor: '#a1a3a7', height: 36 } })
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

  /*
   * A reload throws away everything the renderer knew, including which panes
   * were mid-turn. An agent turn parked on a permission question is waiting on
   * a click from a window that no longer exists, and the fresh renderer has no
   * thread to deliver the question to, so nothing would ever answer it.
   */
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) agentService?.cancelAll();
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

  if (IS_FLEET_DEV && process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    mainWindow.webContents.once('did-finish-load', () => {
      try {
        const file = sessionFilePath(process.cwd());
        mkdirSync(dirname(file), { recursive: true });
        const session: DriveSession = { port: fleetDrivePort, rendererUrl, pid: process.pid };
        writeFileSync(file, JSON.stringify(session, null, 2));
      } catch (err) {
        log.warn('failed to write fleet-drive session', { error: String(err) });
      }
    });
  }
}

app.setName('Fleet');

// Windows shows a toast only for an app it can identify, and says nothing at
// all - no error, no toast - for one it cannot. Matches `appId` in
// electron-builder.yml, which is what the installed shortcut is stamped with.
if (process.platform === 'win32') app.setAppUserModelId('com.fleet.app');

// fleet-drive: enable CDP so `npm run drive` can attach to this dev window.
// Dev-only, loopback-only, per-checkout port. Never present in packaged builds.
let fleetDrivePort = 0;
if (IS_FLEET_DEV) {
  fleetDrivePort = deriveDebugPort(process.cwd(), process.env.FLEET_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-port', String(fleetDrivePort));
}

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
  socketSupervisor = new SocketSupervisor(SOCKET_PATH, imageService, annotateService);
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

  // Reflect aggregate "awaiting input" state in OS chrome (window title, dock
  // badge). Each half is independently gated by that state's existing `badge`
  // notification setting, so users can opt a category out the same way they
  // already opt out of its OS notification/sound.
  function updateChrome(): void {
    const settings = settingsStore.get();
    const watched = activityTracker.getCounts();
    const reported = reportedActivity.getCounts();
    // Panes main watches and panes that report themselves are one population to
    // the dock: the user counting badges is not counting shells.
    const counts = {
      needsMe: watched.needsMe + reported.needsMe,
      error: watched.error + reported.error
    };
    const needsMe = settings.notifications.needsPermission.badge ? counts.needsMe : 0;
    const errorCount = settings.notifications.processExitError.badge ? counts.error : 0;
    const total = needsMe + errorCount;

    const parts: string[] = [];
    if (needsMe > 0) parts.push(`${needsMe} awaiting input`);
    if (errorCount > 0) parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
    const title = parts.length > 0 ? `${parts.join(', ')} · Fleet` : 'Fleet';

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title);
    }
    if (process.platform === 'darwin') {
      app.dock?.setBadge(total > 0 ? String(total) : '');
    } else {
      app.setBadgeCount(total);
    }
  }

  // Clean up CWD polling and activity tracking when panes close
  eventBus.on('pane-closed', (event) => {
    cwdPoller.stopPolling(event.paneId);
    activityTracker.untrackPane(event.paneId);
    updateChrome();
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
    updateChrome();
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

  /**
   * Notifications still waiting to be clicked.
   *
   * Held only so they are not collected before the user answers them: a
   * `Notification` nothing refers to can be swept up with its click handler,
   * and the banner then does nothing when clicked.
   */
  const liveNotifications = new Set<Notification>();

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
      // Named where we can. With several panes running, "an agent" is the one
      // thing the user already knows and the folder is what they need. Only a
      // pane that reports itself has a name to use; a terminal is described the
      // way it always was.
      const where = reportedActivity.labelOf(batch[0].paneId);
      if (hasPermission) {
        body =
          where === undefined
            ? 'An agent needs your permission'
            : `Agent in ${where} needs your permission`;
      } else if (hasError) {
        body =
          where === undefined ? 'A process exited with an error' : `Agent in ${where} hit an error`;
      } else {
        body = where === undefined ? 'Task completed' : `Agent in ${where} finished`;
      }
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
    liveNotifications.add(notif);
    notif.on('close', () => liveNotifications.delete(notif));
    // macOS refuses to show these at all for a binary it cannot verify, and
    // says so only here. Without this the failure is silent and looks like a
    // notification the user missed.
    notif.on('failed', (_event, error) => {
      liveNotifications.delete(notif);
      log.warn('desktop notification failed', { error });
    });
    notif.on('click', () => {
      liveNotifications.delete(notif);
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

  /**
   * Raise one event, as loudly as the distance to the user warrants.
   *
   * The choice is made here, in main, for every pane: only main knows whether
   * the window is focused, and a second opinion in the renderer would be a
   * second chance to disagree. The renderer is told to chime rather than
   * deciding to - which is also what keeps a desktop notification and a chime
   * from both announcing the same question.
   */
  function raiseAlerts(paneId: string, level: NotificationLevel): void {
    const settings = settingsStore.get();
    const attention = attentionOf({
      windowFocused: mainWindow?.isFocused() === true,
      paneVisible: visiblePaneIds.has(paneId)
    });
    const alerts = alertsFor(attention, level, settings.notifications[channelsKeyFor(level)]);

    if (alerts.chime) {
      const w = mainWindow;
      if (w && !w.isDestroyed()) w.webContents.send(IPC_CHANNELS.ACTIVITY_CHIME);
    }
    if (alerts.os) {
      pendingOsNotifications.push({ paneId, level });
      osNotifTimer ??= setTimeout(flushOsNotifications, OS_NOTIF_BATCH_MS);
    }
  }

  eventBus.on('notification', (event) => {
    raiseAlerts(event.paneId, event.level);
  });

  ipcMain.on(IPC_CHANNELS.ACTIVITY_VISIBLE_PANES, (_event, payload: unknown) => {
    const parsed = VisiblePanesSchema.safeParse(payload);
    if (!parsed.success) return;
    visiblePaneIds = new Set(parsed.data);
  });

  ipcMain.on(IPC_CHANNELS.ACTIVITY_REPORT, (_event, payload: unknown) => {
    const parsed = ActivityReportSchema.safeParse(payload);
    if (!parsed.success) return;
    routeActivityReport(parsed.data, {
      isWatched: (paneId) => activityTracker.getState(paneId) !== undefined,
      reported: reportedActivity,
      emitNotification: (paneId, level) =>
        eventBus.emit('notification', {
          type: 'notification',
          paneId,
          level,
          timestamp: Date.now()
        }),
      raiseAlerts,
      updateChrome
    });
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

  // One shared embedding worker (transformers.js model in a worker thread) powers
  // both the learnings KB and chat semantic search — a single model download and a
  // single inference thread. Constructed here so the chat store (below) and the
  // learnings subsystem (further down) can share the instance.
  const learningsHome = join(homedir(), '.fleet', 'learnings');
  const learningsModelDir = join(learningsHome, 'models');
  const sharedEmbedder = new WorkerEmbedder({ modelCacheDir: learningsModelDir });

  const chatStore = new ChatStore(join(app.getPath('userData'), 'chat.db'));
  const chatSecrets = new ChatSecrets();
  const chatClient = new OpenRouterClient();
  const chatWorkspace = new ChatWorkspace(
    join(homedir(), '.fleet', 'chat'),
    join(app.getPath('userData'), 'chat-images')
  );
  const chatImageStorage = new ChatImageStorage(chatWorkspace);
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
        { root: join(skillsResourcesDir, 'chat-skills'), scope: 'bundled' },
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
  const isWebSearchReady = (): boolean => {
    const cfg = settingsStore.get().ai.chat.webSearch;
    return cfg.enabled && chatSecrets.hasSearchKey(cfg.provider);
  };
  const chatWebSearch: WebSearchRunner = {
    enabled: isWebSearchReady,
    search: async (query, signal) => {
      const cfg = settingsStore.get().ai.chat.webSearch;
      const key = chatSecrets.getSearchKey(cfg.provider);
      if (!key) throw new Error('No web-search API key configured');
      const provider = createWebSearchProvider(cfg.provider);
      const results = await provider.search({
        query,
        apiKey: key,
        maxResults: cfg.maxResults,
        signal
      });
      return formatWebSearchResults(query, results);
    }
  };
  const isWebFetchReady = (): boolean => settingsStore.get().ai.chat.webFetch.enabled;
  const chatWebFetch: WebFetchRunner = {
    enabled: isWebFetchReady,
    fetch: async (url, signal, onRender) => {
      const cfg = settingsStore.get().ai.chat.webFetch;
      const content = await extractContent({
        url,
        deps: { render: renderPage },
        signal,
        onRender
      });
      return capResult(content, cfg.maxChars);
    }
  };
  const chatToolExecutor = new ChatToolExecutor(
    chatPermissions,
    () => settingsStore.get().ai.chat.tools,
    chatEmit,
    chatWorkspace,
    chatMcp,
    (entry) => chatStore.addAudit(entry),
    chatWebSearch,
    chatWebFetch
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
    getAutoTag: () => {
      const c = settingsStore.get().ai.chat;
      return { enabled: c.autoTag, model: c.taskModel ?? c.defaultModel };
    },
    getToolsMode: () => settingsStore.get().ai.chat.tools.mode,
    getTools: () => settingsStore.get().ai.chat.tools,
    getUsage: () => settingsStore.get().ai.chat.usage,
    getPersonas: () => {
      const c = settingsStore.get().ai.chat;
      return { presets: c.personas, defaultId: c.defaultPersonaId };
    },
    isWebSearchReady,
    isWebFetchReady,
    getMcpToolDefs: () => chatMcp.getToolDefs(),
    skills: chatSkills,
    toolExecutor: chatToolExecutor,
    imageProvider: chatImageProvider,
    imageStorage: chatImageStorage,
    workspace: chatWorkspace,
    emit: chatEmit
  });
  // Hybrid keyword + semantic search over chat messages, sharing the embed worker.
  // The write hook embeds each new message in the background as it's persisted.
  const chatSearch = new ChatSearchService(chatStore, sharedEmbedder);
  chatStore.setMessageWriteHook((m) => chatSearch.scheduleEmbed(m.id, m.content));

  registerChatIpc({
    store: chatStore,
    search: chatSearch,
    secrets: chatSecrets,
    service: chatService,
    settingsStore,
    permissions: chatPermissions,
    mcp: chatMcp,
    skills: chatSkills,
    workspace: chatWorkspace,
    imageStorage: chatImageStorage,
    revealSkillsFolder: () => {
      mkdirSync(personalSkillsDir, { recursive: true });
      void shell.openPath(personalSkillsDir);
    }
  });

  // Agent panes. Separate from Chat by design: it shares only the OpenRouter key
  // and the settings store, both of which are app-wide.
  const agentEmit = (channel: string, payload: unknown): void => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  const agentGitWatcher = new AgentGitWatcher((paneId, head) =>
    agentEmit(IPC_CHANNELS.AGENT_GIT_HEAD, { paneId, head })
  );
  // Someone who switched branch in a terminal outside Fleet is most likely to
  // look at the pane the moment they come back to it, so coming back is when
  // every pane re-reads. FSEvents also coalesces across sleep, and this is what
  // covers the wake.
  app.on('browser-window-focus', () => agentGitWatcher.refreshAll());

  const agentGate = new PermissionGate({
    getRules: () => settingsStore.get().ai.agent.permissions,
    persistAllow: (rule) => {
      const { permissions } = settingsStore.get().ai.agent;
      if (permissions.allow.includes(rule)) return;
      settingsStore.set({
        ai: { agent: { permissions: { ...permissions, allow: [...permissions.allow, rule] } } }
      });
    },
    persistAllowMcp: (rule) => {
      const { permissions } = settingsStore.get().ai.agent;
      if (permissions.mcp.allow.includes(rule)) return;
      settingsStore.set({
        ai: {
          agent: {
            permissions: {
              ...permissions,
              mcp: { ...permissions.mcp, allow: [...permissions.mcp.allow, rule] }
            }
          }
        }
      });
    },
    emit: agentEmit
  });
  // MCP servers for the Agent pane. Deliberately its own manager, its own
  // config and its own secret store: Chat's are next door and stay there, so
  // one pane's server list cannot change what the other can do.
  const agentMcpSecrets = new AgentMcpSecrets();
  // The authorization endpoint comes from the server's own metadata, so it is
  // not an address Fleet chose. Anything that is not a web address is refused
  // out loud rather than quietly not opened, which would leave the sign-in
  // waiting on a browser that never appeared.
  const openMcpSignIn = async (url: string): Promise<void> => {
    if (!isSafeExternalUrl(url)) throw new Error('That sign-in page is not a web address.');
    await shell.openExternal(url);
  };
  agentMcp = new AgentMcpManager({
    getConfig: () => settingsStore.get().ai.agent.mcpServers,
    getAuth: (name, cfg) =>
      resolveAuth(name, cfg, { secrets: agentMcpSecrets, openExternal: openMcpSignIn }),
    signIn: async (name, cfg, signal) =>
      signInToMcp(name, cfg, { secrets: agentMcpSecrets, openExternal: openMcpSignIn }, signal),
    onStatusChange: (statuses) => agentEmit(IPC_CHANNELS.AGENT_MCP_STATUS, statuses)
  });
  // Not awaited: a server that takes its time to start must not hold up the
  // window, and the pane finds out on AGENT_MCP_STATUS either way.
  void agentMcp.reload();

  agentService = new AgentService({
    getSettings: () => settingsStore.get().ai.agent,
    getApiKey: () => chatSecrets.getKey(),
    gate: agentGate,
    mcp: agentMcp,
    emit: agentEmit
  });
  const agentSessions = new AgentSessionStore();
  // Once, here, before any pane has had the chance to attach anything: a
  // picture that has not been sent yet is a folder with no session behind it.
  agentSessions.sweep();
  registerAgentIpc({
    catalog: new AgentModelCatalog(join(app.getPath('userData'), 'agent-models-dev.json')),
    service: agentService,
    gate: agentGate,
    sessions: agentSessions,
    attachments: new AgentImageStore(AGENT_ATTACHMENTS_DIR),
    git: agentGitWatcher,
    history: new AgentHistoryStore(),
    mcp: {
      manager: agentMcp,
      secrets: agentMcpSecrets,
      getServers: () => settingsStore.get().ai.agent.mcpServers,
      setServers: (mcpServers) => settingsStore.set({ ai: { agent: { mcpServers } } })
    },
    getSettings: () => settingsStore.get().ai.agent,
    getApiKey: () => chatSecrets.getKey()
  });

  // Cheap AI one-line pane summaries for the agent overview, throttled per pane
  // so the overview polling on an interval doesn't re-call the model every tick.
  const paneSummaryCache = new Map<string, { summary: string; at: number }>();
  // Guards against a slow model response overlapping the next poll tick for the
  // same pane (renderer interval fires again before the first call resolves).
  const paneSummaryInFlight = new Map<string, Promise<string>>();
  const PANE_SUMMARY_MIN_INTERVAL_MS = 15_000;

  ipcMain.handle(
    IPC_CHANNELS.AI_SUMMARIZE_PANE,
    async (_e, req: { paneId: string; tailText: string }): Promise<string> => {
      const cached = paneSummaryCache.get(req.paneId);
      if (cached && Date.now() - cached.at < PANE_SUMMARY_MIN_INTERVAL_MS) {
        return cached.summary;
      }
      const inFlight = paneSummaryInFlight.get(req.paneId);
      if (inFlight) return inFlight;

      const apiKey = chatSecrets.getKey();
      if (!apiKey) return '';
      const c = settingsStore.get().ai.chat;
      const request = (async (): Promise<string> => {
        const summary = await resolveSummary(chatClient, {
          apiKey,
          model: c.taskModel ?? c.defaultModel,
          tailText: req.tailText
        });
        if (summary) paneSummaryCache.set(req.paneId, { summary, at: Date.now() });
        return summary || cached?.summary || '';
      })();
      paneSummaryInFlight.set(req.paneId, request);
      try {
        return await request;
      } finally {
        paneSummaryInFlight.delete(req.paneId);
      }
    }
  );
  eventBus.on('pane-closed', (event) => {
    paneSummaryCache.delete(event.paneId);
    paneSummaryInFlight.delete(event.paneId);
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

  registerRemoteSshIpcHandlers(ptyManager);

  const learningsStoreRef = new LearningsStore(join(learningsHome, 'learnings.db'));
  // Reuse the one shared embed worker constructed above (chat + learnings share it).
  const learningsEmbedderRef = sharedEmbedder;
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
    )
    // Chat embedding backfill is independent of the learnings MCP — run it regardless
    // of whether the MCP bound, but after (sequentially) so the two backfills don't
    // contend for the shared inference thread at startup.
    .finally(() => {
      void runChatBackfill(chatStore, sharedEmbedder).catch((err: unknown) =>
        log.error('chat embedding backfill failed', {
          error: err instanceof Error ? err.message : String(err)
        })
      );
    });
  sessionsService.startWatching(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.SESSIONS_CHANGED);
    }
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
  // Kills the running command and settles any permission question still on
  // screen as a refusal, so nothing starts on the way out.
  agentService?.cancelAll();
  // Spawned servers are child processes of this one, so a quit that skipped
  // this would leave them running with nothing to talk to.
  void agentMcp?.closeAll();
  sessionsService?.dispose();
  annotateService.destroy();
  runeAssist?.dispose();
  void learningsMcp?.stop();
  void learningsEmbedder?.close();
  learningsStore?.close();
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
