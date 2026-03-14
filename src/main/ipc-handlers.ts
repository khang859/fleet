import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS, DEFAULT_SETTINGS } from '../shared/constants';
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

export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  getWindow: () => BrowserWindow | null,
): void {
  // PTY handlers
  ipcMain.handle(IPC_CHANNELS.PTY_CREATE, (_event, req: PtyCreateRequest) => {
    const result = ptyManager.create(req);
    const win = getWindow();

    ptyManager.onData(req.paneId, (data) => {
      win?.webContents.send(IPC_CHANNELS.PTY_DATA, { paneId: req.paneId, data } satisfies PtyDataPayload);
    });

    ptyManager.onExit(req.paneId, (exitCode) => {
      win?.webContents.send(IPC_CHANNELS.PTY_EXIT, { paneId: req.paneId, exitCode } satisfies PtyExitPayload);
      eventBus.emit('pty-exit', { type: 'pty-exit', paneId: req.paneId, exitCode });
    });

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
  ipcMain.on(IPC_CHANNELS.PANE_FOCUSED, (_event, _payload: PaneFocusedPayload) => {
    // Clear notification state for this pane — consumed by notification system in Layer 2
  });

  // Settings handlers (stub — full implementation in Layer 5)
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return DEFAULT_SETTINGS;
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, _settings) => {
    // Stub — settings persistence added in Layer 5
  });
}
