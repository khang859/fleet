import { ipcMain, BrowserWindow } from 'electron';
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
} from '../shared/ipc-api';
import type { Workspace } from '../shared/types';
import { PtyManager } from './pty-manager';
import { LayoutStore } from './layout-store';
import { EventBus } from './event-bus';
import { NotificationDetector } from './notification-detector';
import { NotificationStateManager } from './notification-state';
import { SettingsStore } from './settings-store';
import { CwdPoller } from './cwd-poller';
import { GitService } from './git-service';
import type { FleetSettings } from '../shared/types';
import type { SectorService } from './starbase/sector-service';
import type { ConfigService } from './starbase/config-service';

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
  sectorService?: SectorService | null,
  configService?: ConfigService | null,
): void {
  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, (_event, req: PtyCreateRequest) => {
    const result = ptyManager.create(req);

    ptyManager.onData(req.paneId, (data) => {
      notificationDetector.scan(req.paneId, data);
      const w = getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId: req.paneId, data } satisfies PtyDataPayload);
      }
    });

    ptyManager.onExit(req.paneId, (exitCode) => {
      const w = getWindow();
      if (w && !w.isDestroyed()) {
        w.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId: req.paneId, exitCode } satisfies PtyExitPayload);
      }
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId: req.paneId, exitCode });
    });

    // Start CWD polling fallback for shells that don't emit OSC 7
    cwdPoller.startPolling(req.paneId, result.pid);

    eventBus.emit('pane-created', { type: 'pane-created', paneId: req.paneId });
    return result;
  });

  ipcMain.on(IPC_CHANNELS.PTY_INPUT, (_event, payload: PtyInputPayload) => {
    ptyManager.write(payload.paneId, payload.data);
  });

  ipcMain.on(IPC_CHANNELS.PTY_RESIZE, (_event, payload: PtyResizePayload) => {
    ptyManager.resize(payload.paneId, payload.cols, payload.rows);
  });

  ipcMain.on(IPC_CHANNELS.PTY_KILL, (_event, paneId: string) => {
    ptyManager.kill(paneId);
    eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
  });

  // Garbage-collect orphaned PTYs: renderer sends list of active pane IDs,
  // main kills any PTY not in that list.
  ipcMain.on(IPC_CHANNELS.PTY_GC, (_event, activePaneIds: string[]) => {
    const killed = ptyManager.gc(new Set(activePaneIds));
    if (killed.length > 0) {
      console.log(`[pty-gc] killed ${killed.length} orphaned PTY(s):`, killed);
      for (const paneId of killed) {
        eventBus.emit('pane-closed', { type: 'pane-closed', paneId });
      }
    }
  });

  // Layout handlers
  ipcMain.handle(IPC_CHANNELS.LAYOUT_SAVE, (_event, req: LayoutSaveRequest) => {
    layoutStore.save(req.workspace);
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LOAD, (_event, workspaceId: string): Workspace | undefined => {
    return layoutStore.load(workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_LIST, (): LayoutListResponse => {
    return { workspaces: layoutStore.list() };
  });

  ipcMain.handle(IPC_CHANNELS.LAYOUT_DELETE, (_event, workspaceId: string) => {
    layoutStore.delete(workspaceId);
  });

  // Notification handlers
  ipcMain.on(IPC_CHANNELS.PANE_FOCUSED, (_event, payload: PaneFocusedPayload) => {
    notificationState.clearPane(payload.paneId);
  });

  // Settings handlers
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return settingsStore.get();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, settings: Partial<FleetSettings>) => {
    settingsStore.set(settings);
  });

  // Git handlers
  ipcMain.handle(IPC_CHANNELS.GIT_IS_REPO, (_event, cwd: string) => {
    return gitService.checkIsRepo(cwd);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_event, cwd: string) => {
    return gitService.getFullStatus(cwd);
  });

  // Starbase handlers
  if (sectorService && configService) {
    ipcMain.handle(IPC_CHANNELS.STARBASE_LIST_SECTORS, () => sectorService.listSectors());
    ipcMain.handle(IPC_CHANNELS.STARBASE_ADD_SECTOR, (_e, req) => sectorService.addSector(req));
    ipcMain.handle(IPC_CHANNELS.STARBASE_REMOVE_SECTOR, (_e, { sectorId }) => sectorService.removeSector(sectorId));
    ipcMain.handle(IPC_CHANNELS.STARBASE_UPDATE_SECTOR, (_e, { sectorId, fields }) => sectorService.updateSector(sectorId, fields));
    ipcMain.handle(IPC_CHANNELS.STARBASE_GET_CONFIG, () => configService.getAll());
    ipcMain.handle(IPC_CHANNELS.STARBASE_SET_CONFIG, (_e, { key, value }) => configService.set(key, value));
  }
}
