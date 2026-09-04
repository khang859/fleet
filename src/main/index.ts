import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Notification,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  session as electronSession,
  shell,
  systemPreferences
} from 'electron';
import { safeOpenExternal, isSafeExternalUrl } from './safe-external';
import { shouldCheck, UPDATE_CHECK_INTERVAL_MS } from './update-scheduler';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
import { backfillBackgroundStore, pruneBackgroundStore } from './background-store';
import { IPC_CHANNELS, IS_FLEET_DEV, SOCKET_PATH } from '../shared/constants';
import { deriveDebugPort, sessionFilePath, type DriveSession } from '../shared/drive-session';
import { SocketSupervisor } from './socket-supervisor';
import { QuitGuard } from './quit-guard';
import { QuitDecideSchema, type QuitWorkItem } from '../shared/quit-confirm';
import { CwdPoller } from './cwd-poller';
import { installFleetCLI, installSkillFile, installOpencodePlugin } from './install-fleet-cli';
import { AnnotateService } from './annotate-service';
import { AnnotationStore } from './annotation-store';
import { EnvSyncManager } from './env-sync/env-sync-manager';
import { EnvSyncSecrets } from './env-sync/env-sync-secrets';
import { WorktreeService } from './worktree-service';
import { enrichProcessEnv } from './shell-env';
import { WslService } from './wsl-service';
import { parseFleetUrl } from './protocol-paths';
import { toWslUncPath } from '../shared/path-platform';
import { ShellProfileRegistry, defaultFileExists } from './shell-profiles';
import type { HostContextPayload } from '../shared/ipc-api';
import type { NotificationLevel, UpdateStatus } from '../shared/types';
import { createLogger } from './logger';
import { initCopilot, stopCopilot, pruneDeadCopilotSessions } from './copilot/index';
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
import { OpenRouterSecrets } from './openrouter-secrets';
import { registerAgentIpc } from './agent/agent-ipc';
import { completeOnce } from './agent/completions';
import { AgentModelCatalog } from './agent/models-catalog';
import { AgentCatalogComposer } from './agent/catalog-composer';
import { resolveTarget as resolveModelTarget, type ResolvedTarget } from './agent/model-routing';
import { LocalEndpointManager } from './agent/endpoints/manager';
import { LocalEndpointConfigSchema, type LocalEndpointConfig } from '../shared/agent-endpoints';
import { registerAgentEndpointIpc } from './agent/endpoints/endpoint-ipc';
import { AgentService } from './agent/agent-service';
import { coalesceStreamDeltas } from './agent/stream-emit';
import { AgentSessionStore } from './agent/session-store';
import { AGENT_ATTACHMENTS_DIR, AgentImageStore } from './agent/image-store';
import { PermissionGate } from './agent/permissions/gate';
import { classifyCommand } from './agent/permissions/classifier';
import { AgentGitWatcher } from './agent/git-watch';
import { AgentHistoryStore } from './agent/history-store';
import { McpManager as AgentMcpManager } from './agent/mcp/manager';
import { SubagentManager } from './agent/subagents/manager';
import { ScheduleStore } from './agent/schedule-store';
import { ScheduleTimer } from './agent/schedule-timer';
import type { AgentScheduleChanged } from '../shared/agent-schedule';
import { discardAllFetches } from './agent/skills/fetch';
import { killAllBackgroundCommands, listRunningBackgroundCommands } from './agent/tools/background';
import { AgentMcpSecrets } from './agent/mcp/secrets';
import { resolveAuth, signIn as signInToMcp } from './agent/mcp/auth';
import { registerRemoteSshIpcHandlers } from './remote-ssh/ipc-handlers';
import { PtyOscBridge } from './remote-ssh/pty-osc-bridge';
import { detectSshHost } from './remote-ssh/ssh-host-detect';
import type { RemoteSshService } from './remote-ssh/remote-ssh-service';
import { resolveSummary } from './pane-summarizer';
import type { AppUpdater } from 'electron-updater';

const log = createLogger('fleet-main');
const updaterLog = createLogger('auto-updater');

// Preferred loopback port for the Learnings KB MCP server. Fixed so the URL written
// into ~/.claude.json stays stable across restarts; falls back
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
let agentSubagents: SubagentManager | null = null;
let agentScheduleTimer: ScheduleTimer | null = null;
/** The periodic update check, cleared on the way out with the other timers. */
let updateCheckTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Set once the user has confirmed a close, so the second `close` - the one
 * this module raises itself to actually shut the window - runs straight
 * through instead of asking again.
 */
let quitConfirmed = false;
/**
 * Whether the close being confirmed arrived as a *quit* rather than a window
 * close.
 *
 * Cmd+Q raises `before-quit` and only then closes the window, and preventing
 * that close aborts the whole quit. So a confirmed close has to finish the way
 * it started: closing the window would leave a macOS user who pressed Cmd+Q
 * with an app still sitting in the dock. Cleared when the user cancels, so a
 * later click on the X does not inherit a quit nobody asked for.
 */
let quitRequested = false;

const quitGuard = new QuitGuard(() => mainWindow);

const ptyManager = new PtyManager();
const layoutStore = new LayoutStore();
const eventBus = new EventBus();
const settingsStore = new SettingsStore();
const activityTracker = new ActivityTracker(eventBus, {
  silenceThresholdMs: 5000,
  processPollingIntervalMs: 2000,
  getProcessName: (paneId) => ptyManager.getProcessName(paneId)
});
// Built after the tracker because it asks it whether a pane is SSH'd in: OSC 7
// from a remote shell describes a directory this machine does not have.
const notificationDetector = new NotificationDetector(eventBus, (paneId) =>
  activityTracker.isRemote(paneId)
);
const notificationState = new NotificationStateManager(eventBus);
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
/**
 * Set once `registerRemoteSshIpcHandlers` runs, which is much later in startup
 * than the OSC bridge has to exist - the bridge is wired into the PTY data
 * callback, and panes can open before the remote-ssh stack is up.
 */
let remoteSshService: RemoteSshService | null = null;
const ptyOscBridge = new PtyOscBridge({
  eventBus,
  isRemote: (paneId) => activityTracker.isRemote(paneId),
  getPid: (paneId) => ptyManager.getPid(paneId),
  detectHost: detectSshHost,
  download: async (request) => {
    if (!remoteSshService) throw new Error('Remote transfers are not ready yet.');
    await remoteSshService.download(request);
  },
  emitTransfer: (transfer) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.REMOTE_SSH_TRANSFER_PROGRESS, transfer);
    }
  },
  writeClipboard: (text) => clipboard.writeText(text),
  downloadsDir: () => app.getPath('downloads')
});
const ANNOTATIONS_DIR = join(homedir(), '.fleet', 'annotations');
const annotationStore = new AnnotationStore(ANNOTATIONS_DIR);
const annotateService = new AnnotateService(annotationStore);
const envSyncSecrets = new EnvSyncSecrets();
const envSyncManager = new EnvSyncManager({ secrets: envSyncSecrets });
const wslService = new WslService();
const shellProfileRegistry = new ShellProfileRegistry({
  platform: process.platform,
  env: process.env,
  wslService,
  fileExists: defaultFileExists
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

ipcMain.on(IPC_CHANNELS.APP_QUIT_DECIDE, (_event, payload: unknown) => {
  const parsed = QuitDecideSchema.safeParse(payload);
  if (!parsed.success) return;
  quitGuard.decide(parsed.data.requestId, parsed.data.proceed);
});

/**
 * Whether this close takes the process down with it.
 *
 * On macOS a window close leaves the app in the dock and `shutdownAll` never
 * runs, so the subagents and background commands main is holding carry on
 * without a window. Everywhere else, and for a real quit anywhere, the last
 * window closing ends the process and takes them with it.
 *
 * The warning has to know which of the two this is, or it promises a loss that
 * does not happen.
 */
function closeEndsProcess(): boolean {
  return quitRequested || process.platform !== 'darwin';
}

/**
 * The live work this particular close would destroy.
 *
 * Deliberately narrow: a shell sitting at a prompt is `idle` and costs nothing
 * to close, and a warning that fired every time would be clicked through
 * without being read.
 *
 * Panes count whatever kind of close this is. A terminal pane loses its PTY to
 * the `killAll` below, and an agent pane loses the turn it is in the middle
 * of - the transcript is written by the renderer, so a window that goes away
 * mid-turn takes the reply with it even though main keeps generating it.
 *
 * Answered here rather than by asking the renderer, because this decides
 * whether to interrupt the user at all - the same synchronous main-side state
 * `updateChrome` already reads for the dock badge.
 */
function hasRunningWork(endsProcess: boolean): boolean {
  const watched = activityTracker.getCounts();
  if (watched.working > 0 || watched.needsMe > 0) return true;
  const reported = reportedActivity.getCounts();
  if (reported.working > 0 || reported.needsMe > 0) return true;
  if (agentService?.hasInflight() === true) return true;
  if (!endsProcess) return false;
  if ((agentSubagents?.liveIds().length ?? 0) > 0) return true;
  if (listRunningBackgroundCommands().length > 0) return true;
  return false;
}

/**
 * What main knows is running that no pane speaks for.
 *
 * Panes are left out: only the renderer can name one, and it already tracks
 * every pane's state for its own UI, so it builds those rows itself.
 *
 * Empty when the process is staying up, because that is the honest answer -
 * a subagent writes its own report from main and a background command is a
 * process of main's, so neither notices the window closing.
 */
function mainOwnedWork(endsProcess: boolean): QuitWorkItem[] {
  if (!endsProcess) return [];

  const items: QuitWorkItem[] = [];
  for (const job of listRunningBackgroundCommands()) {
    items.push({ kind: 'background', id: job.id, label: job.command });
  }
  for (const live of agentSubagents?.describeLive() ?? []) {
    items.push({
      kind: 'subagent',
      id: live.taskId,
      label: `${live.agent}: ${truncateForList(live.prompt)}`
    });
  }
  return items;
}

function truncateForList(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}\u2026` : flat;
}

/**
 * Ask before throwing away work, then finish the close the way it arrived.
 *
 * Cancelling has no side effects at all - nothing has been torn down by this
 * point - so the app is left exactly as the user found it.
 */
async function confirmClose(endsProcess: boolean): Promise<void> {
  const proceed = await quitGuard.ask(mainOwnedWork(endsProcess));
  if (!proceed) {
    quitRequested = false;
    return;
  }
  quitConfirmed = true;
  if (quitRequested) {
    // Re-runs the quit from the top, `before-quit` included. The window's
    // `close` fires again on the way through and is waved past by the flag.
    app.quit();
    return;
  }
  mainWindow?.close();
}

function createWindow(): void {
  // A macOS window that was closed leaves the app in the dock, and reopening
  // it lands here. Both flags describe one close attempt, so a fresh window
  // starts with a clean pair - otherwise the first close was the last one that
  // ever asked.
  quitConfirmed = false;
  quitRequested = false;

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

  mainWindow.on('close', (event) => {
    // Already confirmed - this is the close `confirmClose` asked for.
    if (quitConfirmed) {
      ptyManager.killAll();
      return;
    }
    const endsProcess = closeEndsProcess();
    if (!hasRunningWork(endsProcess)) {
      ptyManager.killAll();
      return;
    }
    // Preventing this aborts a quit as well as a window close, which is the
    // point: nothing is torn down until the user has said so.
    event.preventDefault();
    // A second attempt while the dialog is up - the X after a Cmd+Q, say -
    // is the same question, so it waits on the answer already being given.
    if (quitGuard.isAsking) return;
    void confirmClose(endsProcess);
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
    if (!details.isMainFrame) return;
    agentService?.cancelAll();
    // Subagents are not cancelled: they are meant to outlive the window, and
    // the fresh renderer reattaches to them when it replays the session. What
    // cannot survive is a question one of them is stopped on, since the screen
    // that would have answered it is gone.
    agentService?.refusePending(agentSubagents?.liveIds() ?? []);
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

/**
 * Defer work that nobody is waiting on until the renderer has finished loading.
 *
 * Anything run straight from `whenReady` competes with the first frame, which
 * is the one thing the user is actually waiting for. Falls back to the next
 * tick if there is no window to wait on, so the work still happens.
 */
function whenWindowReady(fn: () => void): void {
  const contents = mainWindow?.webContents;
  if (!contents?.isLoading()) {
    setImmediate(fn);
    return;
  }
  contents.once('did-finish-load', fn);
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

  // Full access does not survive a restart. It is the one setting that changes
  // what runs on this machine without anybody being asked, and the person it
  // catches out is the one who turned it on for a job that finished days ago -
  // so the app comes up asking, every time, and turning it back on is a click.
  // Ahead of the window and of `registerIpcHandlers`, so the renderer cannot
  // draw a mode that is about to be taken away from it.
  if (settingsStore.get().ai.agent.toolMode === 'full') {
    settingsStore.set({ ai: { agent: { toolMode: 'ask' } } });
  }

  // Take ownership of any background still pointing at the user's own copy of a
  // picture, then drop the copies nothing points at any more. Ahead of the
  // window for the same reason as the line above: nothing tells the renderer a
  // setting changed under it, so a rewrite that landed after it read the
  // settings would be undone by its next save. After the first launch this
  // reads no files at all - every path is already inside the store.
  const savedBackground = settingsStore.get().general.terminalBackground;
  const backfilled = backfillBackgroundStore(savedBackground);
  if (backfilled) settingsStore.set({ general: { terminalBackground: backfilled } });
  pruneBackgroundStore(backfilled ?? savedBackground);

  createWindow();

  // Electron's default refuses getUserMedia outright, so granting it has to be
  // explicit. Deny-by-default is preserved for everything else: only these two,
  // and only on the app's own window.
  //
  // `clipboard-sanitized-write` is every copy button in the app. Writing to the
  // clipboard is a permission a page has to be granted even from a click, so a
  // handler that answers no to everything it does not recognise turns
  // `navigator.clipboard.writeText` into a rejected promise - and the copy
  // buttons, which all show their "copied" toast without waiting for the write,
  // go on saying they worked. Sanitized rather than the raw write: the app only
  // ever puts text on the clipboard.
  const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write']);
  electronSession.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission) && webContents === mainWindow?.webContents);
    }
  );

  // The microphone at the OS level, resolved to a yes or a no.
  //
  // The read is what lets the renderer tell "denied in System Settings" - which
  // the in-app prompt will never come back from - apart from "never been
  // asked", which it will. The ask has to live here too: Electron does not
  // raise the macOS prompt from `getUserMedia`, it only refuses outright for
  // `denied` and `restricted`, and hands a never-asked app a stream of silence.
  // Without this call dictation would record nothing and have nothing to say
  // about why, which is the one outcome the plan rules out.
  //
  // macOS only. Elsewhere there is no OS-level gate to read, so getUserMedia is
  // trusted to manage its own prompt.
  ipcMain.handle(IPC_CHANNELS.AGENT_MIC_ACCESS, async (): Promise<string> => {
    if (process.platform !== 'darwin') return 'granted';
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status !== 'not-determined') return status;
    await systemPreferences.askForMediaAccess('microphone');
    // Re-read rather than keeping the boolean: the status is what the renderer
    // branches on, and a refusal has to come back as `denied` so the copy can
    // point at System Settings instead of offering a prompt that will not come.
    return systemPreferences.getMediaAccessStatus('microphone');
  });

  const gitService = new GitService();
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
    activityTracker,
    new WorktreeService(),
    annotationStore,
    annotateService,
    shellProfileRegistry,
    wslService,
    envSyncManager,
    envSyncSecrets,
    ptyOscBridge
  );

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
  socketSupervisor = new SocketSupervisor(SOCKET_PATH, annotateService);
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

  // Forward the remote shell's working directory. Kept off `cwd-changed` on
  // purpose: nothing here touches ptyManager or the saved layout, because the
  // path belongs to another machine.
  eventBus.on('remote-cwd-changed', (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.REMOTE_CWD, {
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
  let updateState: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle';
  let pendingVersion = '';
  let pendingReleaseNotes = '';
  /** Null until the first check, which is what makes that one run. */
  let lastUpdateCheckAt: number | null = null;
  /** Set once an install has been confirmed, so a second click is a no-op. */
  let installRequested = false;

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

  /**
   * `electron-updater` is the most expensive import the main process has -
   * ~48 ms of `require` counting the ajv/conf/semver tree it drags behind it,
   * on every launch, for something that does nothing until an update exists.
   * Nothing about it is needed to put a window on screen, so it loads on first
   * use: either the renderer asking to check, or the launch check below, which
   * now runs after the window is up rather than in front of it.
   *
   * The IPC handlers stay registered here, eagerly. The renderer may call them
   * the moment it mounts, and a handler that is not yet registered rejects.
   */
  let updaterPromise: Promise<AppUpdater> | null = null;
  async function getUpdater(): Promise<AppUpdater> {
    updaterPromise ??= import('electron-updater').then(({ default: pkg }) => {
      const { autoUpdater } = pkg;
      // Allow checking for updates in dev mode via dev-app-update.yml
      if (!app.isPackaged) {
        autoUpdater.forceDevUpdateConfig = true;
      }

      // Installing on quit is this app's decision, not the updater's. Left on,
      // it attaches its own `onQuit` hook the moment a download finishes and
      // swaps the app out from under any quit at all - including one the user
      // is still being asked to confirm, and one they then cancel.
      autoUpdater.autoInstallOnAppQuit = false;

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
        // An install that errored did not quit, so the waiver it was granted
        // has to go back. Left set, the next close of the window would skip
        // the running-work question entirely.
        if (installRequested) {
          installRequested = false;
          quitConfirmed = false;
        }
        sendUpdateStatus({ state: 'error', message: err.message });
      });

      return autoUpdater;
    });
    return updaterPromise;
  }

  async function runUpdateCheck(): Promise<void> {
    if (updateState === 'checking' || updateState === 'downloading') return;
    lastUpdateCheckAt = Date.now();
    try {
      await (await getUpdater()).checkForUpdates();
    } catch (err) {
      sendUpdateStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Update check failed'
      });
    }
  }

  /**
   * A check asked for by the timer, the window, or the machine waking.
   *
   * All three are routed here rather than at the updater because they overlap:
   * a lid opening fires the wake and the focus together, often with the timer
   * due as well. The gap in `shouldCheck` is what makes that one check.
   *
   * The manual button in Settings deliberately does not come through here - a
   * user who clicks "Check for Updates" is owed an answer, not a throttle.
   */
  function maybeCheckForUpdates(reason: string): void {
    if (!shouldCheck(Date.now(), lastUpdateCheckAt)) return;
    updaterLog.info('scheduled check', { reason });
    void runUpdateCheck();
  }

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => runUpdateCheck());

  ipcMain.handle(IPC_CHANNELS.GET_VERSION, () => app.getVersion());

  /**
   * Install the staged update, having asked first if that throws work away.
   *
   * `quitAndInstall` is not a request to quit - on Windows and Linux it spawns
   * the installer and only then calls `app.quit()`, so the window's own close
   * handler gets its say after the installer is already running and a user who
   * answers "cancel" is left in an app being replaced underneath them. On macOS
   * it reaches native Squirrel and there is no say at all.
   *
   * So the question is asked here, before anything is spawned, using the same
   * `hasRunningWork`/`quitGuard` pair a Cmd+Q goes through. `quitConfirmed`
   * then waves the close that `quitAndInstall` triggers straight past a second
   * prompt to the teardown it wants.
   */
  async function requestInstallUpdate(): Promise<void> {
    if (installRequested) return;
    if (hasRunningWork(true) && !(await quitGuard.ask(mainOwnedWork(true)))) return;
    installRequested = true;
    quitConfirmed = true;
    try {
      (await getUpdater()).quitAndInstall();
    } catch (err) {
      installRequested = false;
      quitConfirmed = false;
      updaterLog.error('install failed', {
        error: err instanceof Error ? err.message : String(err)
      });
      sendUpdateStatus({
        state: 'error',
        message: err instanceof Error ? err.message : 'Install failed'
      });
    }
  }

  ipcMain.on(IPC_CHANNELS.UPDATE_INSTALL, () => {
    void requestInstallUpdate();
  });

  /**
   * A synthetic status, so the nudge can be seen without shipping a release.
   *
   * Goes out through the same `sendUpdateStatus` a real one does, so what it
   * exercises is the whole path - IPC, preload, the hook, the store, the toast
   * and the pill - rather than a store written to directly. Dev only; the
   * channel does not exist in a packaged build, and `send` to a channel nothing
   * listens on is a no-op, so the renderer side stays harmless either way.
   */
  if (IS_FLEET_DEV) {
    ipcMain.on(IPC_CHANNELS.UPDATE_SIMULATE, (_event, status: UpdateStatus) => {
      updaterLog.info('simulated status', { state: status.state });
      sendUpdateStatus(status);
    });
  }

  // Silent check on launch (packaged builds only). Deliberately after the
  // window has painted: the check talks to the network and nobody is waiting
  // on its answer, so it has no business delaying the first frame.
  //
  // The timer and the two wake-ish triggers join it here for the same reason -
  // none of them is worth a millisecond of the first frame.
  if (app.isPackaged) {
    whenWindowReady(() => {
      maybeCheckForUpdates('launch');
      updateCheckTimer = setInterval(() => maybeCheckForUpdates('timer'), UPDATE_CHECK_INTERVAL_MS);
      // A window someone has just come back to is the moment a pending update
      // is worth knowing about, and it is also when the answer is most likely
      // stale - the machine may have been asleep through several timer periods.
      mainWindow?.on('focus', () => maybeCheckForUpdates('focus'));
      powerMonitor.on('resume', () => maybeCheckForUpdates('resume'));
    });
  }

  // One shared embedding worker (transformers.js model in a worker thread) backs
  // the learnings KB: a single model download and a single inference thread.
  const learningsHome = join(homedir(), '.fleet', 'learnings');
  const learningsModelDir = join(learningsHome, 'models');
  const sharedEmbedder = new WorkerEmbedder({ modelCacheDir: learningsModelDir });

  const openRouterSecrets = new OpenRouterSecrets();

  /**
   * Where a call for one model goes - OpenRouter, or a server on this machine.
   *
   * Built here and handed to everything that talks to a model, so that no other
   * part of main has to know that a model can be either. Reads the settings
   * fresh on every call rather than closing over them: an endpoint switched off
   * mid-session has to take effect on the next turn, not the next launch.
   */
  /**
   * The configured endpoints, checked rather than taken on trust.
   *
   * This is where main stops treating the settings file as its own and starts
   * treating it as input: the renderer writes this list, a hand-edited settings
   * file can hold anything, and a `baseUrl` from here becomes the address a
   * turn is sent to. Checked per entry rather than all at once, so one
   * malformed row cannot take the working servers down with it.
   */
  const localEndpoints = (): LocalEndpointConfig[] => {
    const saved: unknown = settingsStore.get().ai.agent.localEndpoints;
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (entry): entry is LocalEndpointConfig => LocalEndpointConfigSchema.safeParse(entry).success
    );
  };

  const resolveTarget = (modelId: string | null): ResolvedTarget =>
    resolveModelTarget(modelId, {
      getOpenRouterKey: () => openRouterSecrets.getKey(),
      getEndpoints: localEndpoints
    });

  // Agent panes.
  const agentSend = (channel: string, payload: unknown): void => {
    const w = mainWindow;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  // Every agent event goes through here, which is what lets the per-token
  // channels be batched without any of them overtaking a tool row. See
  // `coalesceStreamDeltas`.
  const agentEmit = coalesceStreamDeltas(agentSend);
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
    emit: agentEmit,
    // Full access. Read per command rather than closed over, so turning it off
    // takes effect on the next command and not the next turn.
    fullAccess: () => settingsStore.get().ai.agent.toolMode === 'full',
    // Auto mode. Every reason not to consult a model - the mode is off, no
    // model is chosen, nowhere to send the call - comes back as `ask`, which is
    // the answer the gate would have reached without any of this.
    autoApprove: async ({ command, cwd, signal }) => {
      const a = settingsStore.get().ai.agent;
      // Falls through to the coding model rather than to the title model: the
      // one the user already trusts to drive the tools is the honest default,
      // and naming a session is not a judgement about what may run.
      const resolved = resolveTarget(a.classifierModel ?? a.coding.model);
      if (a.toolMode !== 'auto' || !resolved.ok) {
        return { verdict: 'ask', usage: null };
      }
      return classifyCommand(completeOnce, {
        target: resolved.target,
        model: resolved.wireModelId,
        command,
        cwd,
        note: a.classifierNote,
        signal
      });
    }
  });
  // MCP servers for the Agent pane, with their own config and secret store.
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

  // The knot between these two is deliberate and only looks circular: the
  // manager decides *whether* a subagent runs, and the service is *how* one
  // runs, because a subagent is a turn. Tied with a lazy reference rather than
  // a setter so neither can be half-built while the other is using it.
  agentSubagents = new SubagentManager({
    emit: agentEmit,
    run: async (run) => {
      if (agentService === null) throw new Error('The agent is not running.');
      return agentService.runTask(run);
    }
  });
  // Every change to any conversation's schedules goes out on one channel, from
  // inside the store, so a create by a tool, a cancel by the user and a tick
  // finding something due all reach the pane the same way. The push is also the
  // nudge to deliver: main never starts a turn, and a pane that hears its own
  // session changed is what turns a claimed fire into one.
  const agentSchedules = new ScheduleStore({
    onChanged: (sessionId, schedules) =>
      agentEmit(IPC_CHANNELS.AGENT_SCHEDULE_CHANGED, {
        sessionId,
        schedules
      } satisfies AgentScheduleChanged)
  });
  const agentCatalog = new AgentModelCatalog(
    join(app.getPath('userData'), 'agent-models-dev.json')
  );
  // Warmed here rather than waited for at the first turn: what an image model
  // takes is asked for synchronously while a turn is being assembled, and the
  // answer is only useful if it is already on hand.
  void agentCatalog.list();
  const agentEndpoints = new LocalEndpointManager({
    getEndpoints: localEndpoints,
    // The roster is written back so that a model chosen from a server that
    // happens to be off is still in the picker after a restart. Only ever the
    // names - everything else a probe learned is worth exactly as much as the
    // connection it came from.
    rememberModels: (endpointId, lastKnownModels) => {
      // Through the same checked accessor as every other read, rather than
      // straight off the settings store. This one writes the list back, so
      // reading it raw would both trip over a malformed row and persist it
      // again - the one path that could keep a bad entry alive forever.
      const saved = localEndpoints();
      const next = saved.map((endpoint) =>
        endpoint.id === endpointId ? { ...endpoint, lastKnownModels } : endpoint
      );
      if (JSON.stringify(next) === JSON.stringify(saved)) return;
      settingsStore.set({ ai: { agent: { localEndpoints: next } } });
    },
    onStatusChange: (statuses) => agentEmit(IPC_CHANNELS.AGENT_ENDPOINT_STATUS, statuses)
  });
  // Asked once at startup, so that a server the user left running is already
  // known about by the time they open a pane - and so that the picker is right
  // before anyone has visited settings.
  void agentEndpoints.reload();
  const agentModels = new AgentCatalogComposer(agentCatalog, agentEndpoints);
  agentService = new AgentService({
    getSettings: () => settingsStore.get().ai.agent,
    getApiKey: () => openRouterSecrets.getKey(),
    resolveTarget,
    gate: agentGate,
    mcp: agentMcp,
    subagents: agentSubagents,
    schedules: agentSchedules,
    imageCapabilities: (modelId) => agentCatalog.cachedImageModel(modelId),
    emit: agentEmit
  });
  // Ticks once as it starts, which is the whole of the catch-up for schedules
  // that came due while Fleet was closed.
  agentScheduleTimer = new ScheduleTimer(agentSchedules);
  agentScheduleTimer.start();
  const agentSessions = new AgentSessionStore();
  // Once, here, before any pane has had the chance to attach anything: a
  // picture that has not been sent yet is a folder with no session behind it.
  agentSessions.sweep();
  registerAgentEndpointIpc({ manager: agentEndpoints });
  registerAgentIpc({
    catalog: agentModels,
    service: agentService,
    gate: agentGate,
    sessions: agentSessions,
    attachments: new AgentImageStore(AGENT_ATTACHMENTS_DIR),
    git: agentGitWatcher,
    history: new AgentHistoryStore(),
    subagents: agentSubagents,
    schedules: agentSchedules,
    mcp: {
      manager: agentMcp,
      secrets: agentMcpSecrets,
      getServers: () => settingsStore.get().ai.agent.mcpServers,
      setServers: (mcpServers) => settingsStore.set({ ai: { agent: { mcpServers } } })
    },
    getSettings: () => settingsStore.get().ai.agent,
    getApiKey: () => openRouterSecrets.getKey(),
    resolveTarget,
    secrets: openRouterSecrets
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

      const a = settingsStore.get().ai.agent;
      // The cheap model a session's title comes from, falling back to the model
      // that writes the code when no separate one is set.
      const resolved = resolveTarget(a.titleModel ?? a.coding.model);
      if (!resolved.ok) return '';
      const request = (async (): Promise<string> => {
        const summary = await resolveSummary(completeOnce, {
          target: resolved.target,
          model: resolved.wireModelId,
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

  sessionsService = new SessionsService();
  registerSessionsIpcHandlers(sessionsService);

  remoteSshService = registerRemoteSshIpcHandlers(ptyManager);

  const learningsStoreRef = new LearningsStore(join(learningsHome, 'learnings.db'));
  // Reuse the one shared embed worker constructed above.
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
  // Expose the KB to Claude Code over a loopback MCP server, then register it in
  // its global config and backfill embeddings for existing learnings.
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
  // Kills the running command and settles any permission question still on
  // screen as a refusal, so nothing starts on the way out.
  agentService?.cancelAll();
  // Background commands are the ones that would otherwise survive this: they
  // are process groups of our own that nothing is waiting on, so a quit that
  // skipped this would leave a dev server holding a port after Fleet is gone.
  killAllBackgroundCommands();
  // And writes down every subagent still running as interrupted, so a card
  // reopened tomorrow says what happened rather than shimmering forever.
  agentSubagents?.cancelAll();
  // Nothing is lost by stopping this: what is due is on disk, and the first
  // tick of the next launch finds it exactly as this one would have.
  agentScheduleTimer?.stop();
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  // Spawned servers are child processes of this one, so a quit that skipped
  // this would leave them running with nothing to talk to.
  void agentMcp?.closeAll();
  // A skill checkout the user never installed from or closed the dialog on.
  // Synchronous on purpose - see the note on it; this path ends in `exit`.
  discardAllFetches();
  sessionsService?.dispose();
  annotateService.destroy();
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

/**
 * Remember that this close is a quit before the window is asked to close.
 *
 * Electron raises this first and only then closes the windows, so by the time
 * the `close` handler runs it can tell Cmd+Q apart from a click on the X and
 * finish the same way.
 */
app.on('before-quit', () => {
  quitRequested = true;
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
