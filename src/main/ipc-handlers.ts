import { ipcMain, BrowserWindow, dialog } from 'electron';
import { safeOpenExternal } from './safe-external';
import { createLogger, logger } from './logger';

const log = createLogger('ipc');
import { readFile, writeFile, stat, readdir } from 'fs/promises';
import type { Dirent } from 'fs';
import { extname, join, relative } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { IPC_CHANNELS } from '../shared/constants';
import type {
  PtyCreateRequest,
  PtyDataPayload,
  PtyInputPayload,
  PtyResizePayload,
  PtyExitPayload,
  LayoutSaveRequest,
  LayoutListResponse,
  PaneFocusedPayload,
  DirEntry,
  FileSearchRequest,
  LogEntry,
  WorktreeCreateRequest,
  WorktreeRemoveRequest
} from '../shared/ipc-api';
import type { Workspace } from '../shared/types';
import type { PtyManager } from './pty-manager';
import type { LayoutStore } from './layout-store';
import type { EventBus } from './event-bus';
import type { NotificationDetector } from './notification-detector';
import type { NotificationStateManager } from './notification-state';
import type { SettingsStore } from './settings-store';
import type { CwdPoller } from './cwd-poller';
import type { ActivityTracker } from './activity-tracker';
import { toError } from './errors';
import type { GitService } from './git-service';
import type { WorktreeService } from './worktree-service';
import type { AnnotationStore } from './annotation-store';
import type { AnnotateService } from './annotate-service';
import type { PiAgentManager } from './pi-agent-manager';
import type { FleetBridgeServer } from './fleet-bridge';
import type { FleetSettings } from '../shared/types';
import { checkSystemDeps } from './system-checker';
import { searchFiles } from './file-search';
import { searchRecentImages } from './recent-images';
import { startClipboardMonitor, getClipboardHistory } from './clipboard-monitor';
import { onCopilotSettingsChanged } from './copilot/index';

export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  notificationDetector: NotificationDetector,
  notificationState: NotificationStateManager,
  settingsStore: SettingsStore,
  cwdPoller: CwdPoller,
  gitService: GitService,
  getWindow: () => BrowserWindow | null,
  workspacePath: string,
  activityTracker: ActivityTracker,
  worktreeService: WorktreeService,
  annotationStore: AnnotationStore,
  annotateService: AnnotateService,
  piAgentManager: PiAgentManager,
  fleetBridge: FleetBridgeServer
): void {
  // Renderer log bridge — receives batched log entries from renderer and writes to Winston
  ipcMain.on(IPC_CHANNELS.LOG_BATCH, (_event, entries: LogEntry[]) => {
    for (const entry of entries) {
      const childLog = logger.child({ tag: entry.tag });
      const meta = entry.meta ?? {};
      childLog[entry.level](entry.message, meta);
    }
  });

  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, (_event, req: PtyCreateRequest) => {
    log.debug('ipc:pty:create', { paneId: req.paneId, cwd: req.cwd });

    // Resolve Claude config: workspace override → global → default
    const settings = settingsStore.get();
    const wsOverride = req.workspaceId
      ? settings.copilot.workspaceOverrides[req.workspaceId]
      : undefined;
    const claudeConfigDir =
      wsOverride?.claudeConfigDir || settings.copilot.claudeConfigDir || '';

    const extraEnv: Record<string, string> = {};
    if (claudeConfigDir) {
      extraEnv.CLAUDE_CONFIG_DIR = claudeConfigDir;
    }

    const alreadyExisted = ptyManager.has(req.paneId);
    const result = ptyManager.create({
      ...req,
      env: Object.keys(extraEnv).length > 0
        ? { ...process.env, ...extraEnv }
        : undefined
    });

    // Skip re-registering listeners on idempotent path (HMR reloads) to prevent
    // duplicate onExit/onData callbacks stacking up
    if (!alreadyExisted) {
      activityTracker.trackPane(req.paneId);
      ptyManager.onData(req.paneId, (data, paused) => {
        notificationDetector.scan(req.paneId, data);
        activityTracker.onData(req.paneId);
        const w = getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_DATA, {
            paneId: req.paneId,
            data,
            paused
          } satisfies PtyDataPayload);
        }
      });

      ptyManager.onExit(req.paneId, (exitCode) => {
        cwdPoller.stopPolling(req.paneId);
        const w = getWindow();
        if (w && !w.isDestroyed()) {
          w.webContents.send(IPC_CHANNELS.PTY_EXIT, {
            paneId: req.paneId,
            exitCode
          } satisfies PtyExitPayload);
        }
        eventBus.emit('pty-exit', { type: 'pty-exit', paneId: req.paneId, exitCode });
      });

      // Start CWD polling fallback for shells that don't emit OSC 7
      cwdPoller.startPolling(req.paneId, result.pid);

      eventBus.emit('pane-created', { type: 'pane-created', paneId: req.paneId });
    }
    return result;
  });

  ipcMain.on(IPC_CHANNELS.PTY_INPUT, (_event, payload: PtyInputPayload) => {
    ptyManager.write(payload.paneId, payload.data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
    ptyManager.resize(payload.paneId, payload.cols, payload.rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, paneId: string) => {
    log.debug('ipc:pty:kill', { paneId });
    ptyManager.kill(paneId);
    eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
  });

  // PTY drain — renderer signals it has consumed a batch; resume the PTY
  ipcMain.on(IPC_CHANNELS.PTY_DRAIN, (_event, { paneId }: { paneId: string }) => {
    ptyManager.resume(paneId);
  });

  // Attach to a pre-created PTY: drain its buffered output so the renderer
  // can replay what arrived before the terminal component mounted.
  ipcMain.handle(IPC_CHANNELS.PTY_ATTACH, (_event, { paneId }: { paneId: string }) => {
    const entry = ptyManager.get(paneId);
    if (!entry) return { data: '' };
    const data = entry.outputBuffer;
    entry.outputBuffer = '';
    // Resume the PTY if it was paused due to buffer overflow (e.g. during
    // a hard refresh when the renderer wasn't consuming data).
    if (entry.paused) {
      ptyManager.resume(paneId);
    }
    return { data };
  });

  // Garbage-collect orphaned PTYs: renderer sends list of active pane IDs,
  // main kills any PTY not in that list.
  ipcMain.on(IPC_CHANNELS.PTY_GC, (_event, activePaneIds: string[]) => {
    const killed = ptyManager.gc(new Set(activePaneIds));
    if (killed.length > 0) {
      log.info('killed orphaned PTYs', { count: killed.length, paneIds: killed });
      for (const paneId of killed) {
        eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
      }
    }
  });

  // Layout handlers
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SAVE, (_event, req: LayoutSaveRequest) => {
    log.debug('ipc:layout:save', {
      workspaceId: req.workspace.id,
      tabCount: req.workspace.tabs.length
    });
    try {
      layoutStore.save(req.workspace);
      layoutStore.ensureImagesTab(req.workspace.id, workspacePath);
    } catch (err) {
      log.error('failed to save workspace', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LOAD, (_event, workspaceId: string): Workspace | undefined => {
    log.debug('ipc:layout:load', { workspaceId });
    return layoutStore.load(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LIST, (): LayoutListResponse => {
    log.debug('ipc:layout:list');
    return { workspaces: layoutStore.list() };
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_DELETE, (_event, workspaceId: string) => {
    log.debug('ipc:layout:delete', { workspaceId });
    layoutStore.delete(workspaceId);

    // Clean up copilot workspace overrides
    const settings = settingsStore.get();
    if (settings.copilot.workspaceOverrides[workspaceId]) {
      const { [workspaceId]: _, ...remaining } = settings.copilot.workspaceOverrides;
      settingsStore.set({
        copilot: { ...settings.copilot, workspaceOverrides: remaining }
      });
    }
  });

  // Notification handlers
  ipcMain.on(IPC_CHANNELS.PANE_FOCUSED, (_event, payload: PaneFocusedPayload) => {
    notificationState.clearPane(payload.paneId);
  });

  // Settings handlers
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return settingsStore.get();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, settings: Partial<FleetSettings>) => {
    settingsStore.set(settings);
    if (settings.copilot) {
      await onCopilotSettingsChanged();
    }
  });

  // Git handlers
  ipcMain.handle(IPC_CHANNELS.GIT_IS_REPO, async (_event, cwd: string) => {
    return gitService.checkIsRepo(cwd);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async (_event, cwd: string) => {
    return gitService.getFullStatus(cwd);
  });

  // System-level dependency check (app-wide pre-checks screen)
  ipcMain.handle(IPC_CHANNELS.SYSTEM_CHECK, async () => {
    return checkSystemDeps();
  });

  // Open URLs in the default browser (scheme-validated)
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_event, url: string) => {
    await safeOpenExternal(url);
  });

  // Folder picker
  ipcMain.handle(IPC_CHANNELS.SHOW_FOLDER_PICKER, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Open file dialog — allows multi-select, no type filter, starts in provided dir
  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN_DIALOG,
    async (event, { defaultPath }: { defaultPath?: string } = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return [];
      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile', 'multiSelections'],
        defaultPath: defaultPath ?? undefined
      });
      return result.canceled ? [] : result.filePaths;
    }
  );

  // List files recursively in a directory, respecting .gitignore when in a git repo
  ipcMain.handle(IPC_CHANNELS.FILE_LIST, async (_event, { dirPath }: { dirPath: string }) => {
    try {
      // Try git ls-files first (respects .gitignore)
      const { stdout } = await execAsync('git ls-files --cached --others --exclude-standard', {
        cwd: dirPath,
        maxBuffer: 10 * 1024 * 1024
      });
      const files = stdout
        .split('\n')
        .filter(Boolean)
        .map((f) => ({
          path: join(dirPath, f),
          relativePath: f,
          name: f.split('/').pop() ?? f
        }));
      return { success: true, files };
    } catch {
      // Fallback: manual recursive walk with common ignore patterns
      const IGNORE_DIRS = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        '.nuxt',
        'coverage',
        '__pycache__',
        '.cache',
        '.parcel-cache',
        'out',
        '.svelte-kit'
      ]);
      const files: Array<{ path: string; relativePath: string; name: string }> = [];

      async function walk(dir: string, base: string): Promise<void> {
        let entries: Dirent[];
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
              await walk(join(dir, entry.name), base);
            }
          } else if (entry.isFile()) {
            const abs = join(dir, entry.name);
            const rel = relative(base, abs);
            files.push({ path: abs, relativePath: rel, name: entry.name });
          }
        }
      }

      await walk(dirPath, dirPath);
      return { success: true, files };
    }
  });

  // File operations
  ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: string) => {
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, 'utf-8');
      return { success: true, data: { content, size: stats.size, modifiedAt: stats.mtimeMs } };
    } catch (err) {
      return { success: false, error: toError(err).message };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.FILE_WRITE,
    async (_event, { filePath, content }: { filePath: string; content: string }) => {
      try {
        await writeFile(filePath, content, 'utf-8');
        return { success: true };
      } catch (err) {
        return { success: false, error: toError(err).message };
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.FILE_STAT, async (_event, filePath: string) => {
    try {
      const stats = await stat(filePath);
      const ext = extname(filePath).toLowerCase().slice(1);
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon'
      };
      const mimeType = mimeTypes[ext] ?? 'application/octet-stream';
      return { success: true, data: { size: stats.size, modifiedAt: stats.mtimeMs, mimeType } };
    } catch (err) {
      return { success: false, error: toError(err).message };
    }
  });

  // List immediate children of a directory (single level, no recursion)
  ipcMain.handle(IPC_CHANNELS.FILE_READDIR, async (_event, { dirPath }: { dirPath: string }) => {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return { success: true, entries: sortAndMapDirEntries(entries, dirPath) };
    } catch (err) {
      return { success: false, error: toError(err).message, entries: [] };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_READ_BINARY, async (_event, filePath: string) => {
    try {
      const ext = extname(filePath).toLowerCase().slice(1);
      const mimeTypes: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',
        bmp: 'image/bmp',
        ico: 'image/x-icon'
      };
      const mimeType = mimeTypes[ext] ?? 'application/octet-stream';
      const buffer = await readFile(filePath);
      const base64 = buffer.toString('base64');
      return { success: true, data: { base64, mimeType } };
    } catch (err) {
      return { success: false, error: toError(err).message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, req: FileSearchRequest) =>
    searchFiles(req)
  );

  ipcMain.handle(IPC_CHANNELS.FILE_RECENT_IMAGES, async () => searchRecentImages());

  // Clipboard history
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_HISTORY, () => ({
    entries: getClipboardHistory()
  }));

  startClipboardMonitor();

  // Worktree handlers
  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_CREATE,
    async (_event, req: WorktreeCreateRequest) => {
      return worktreeService.create(req.repoPath);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKTREE_REMOVE,
    async (_event, req: WorktreeRemoveRequest) => {
      return worktreeService.remove(req.worktreePath);
    }
  );

  // ── Annotate ────────────────────────────────────────────────────────────
  ipcMain.handle(IPC_CHANNELS.ANNOTATE_LIST, () => {
    return annotationStore.list();
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATE_GET, (_event, id: string) => {
    return annotationStore.get(id);
  });

  ipcMain.handle(IPC_CHANNELS.ANNOTATE_DELETE, (_event, id: string) => {
    annotationStore.delete(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.ANNOTATE_UI_START,
    async (_event, args: { url?: string; timeout?: number; mode?: string }) => {
      const resultPath = await annotateService.start({
        url: args.url,
        timeout: args.timeout,
        mode: args.mode === 'draw' ? 'draw' : 'select'
      });
      return { resultPath };
    }
  );

  ipcMain.handle(IPC_CHANNELS.PI_LAUNCH_CONFIG, async (_event, req: { paneId: string }) => {
    await piAgentManager.ensureInstalled();
    const token = fleetBridge.generateToken();
    const port = fleetBridge.getPort();
    const cmd = piAgentManager.buildLaunchCommand(port, token, req.paneId);
    return { cmd };
  });
}

// Exported for testing
export function sortAndMapDirEntries(entries: Dirent[], dirPath: string): DirEntry[] {
  return entries
    .filter((e) => e.isFile() || e.isDirectory())
    .sort((a, b) => {
      const aIsDir = a.isDirectory();
      const bIsDir = b.isDirectory();
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((e) => ({
      name: e.name,
      path: join(dirPath, e.name),
      isDirectory: e.isDirectory()
    }));
}
