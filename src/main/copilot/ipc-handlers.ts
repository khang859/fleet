import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { CopilotSessionStore } from './session-store';
import type { CopilotSocketServer } from './socket-server';
import type { CopilotWindow } from './copilot-window';
import type { SettingsStore } from '../settings-store';
import * as hookInstaller from './hook-installer';

const log = createLogger('copilot:ipc');

export function registerCopilotIpcHandlers(
  sessionStore: CopilotSessionStore,
  socketServer: CopilotSocketServer,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore,
  onSettingsChanged?: () => Promise<void>
): void {
  ipcMain.handle(IPC_CHANNELS.COPILOT_SESSIONS, () => {
    return sessionStore.getSessions();
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_RESPOND_PERMISSION,
    (_event, args: { toolUseId: string; decision: 'allow' | 'deny'; reason?: string }) => {
      log.info('permission response', { toolUseId: args.toolUseId, decision: args.decision });
      return socketServer.respondToPermission(args.toolUseId, args.decision, args.reason);
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPILOT_GET_SETTINGS, () => {
    return settingsStore.get().copilot;
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_SET_SETTINGS,
    async (_event, partial: Record<string, unknown>) => {
      log.info('COPILOT_SET_SETTINGS', { partial });
      settingsStore.set({ copilot: { ...settingsStore.get().copilot, ...partial } });
      if ('enabled' in partial && onSettingsChanged) {
        await onSettingsChanged();
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPILOT_INSTALL_HOOKS, () => {
    hookInstaller.install();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS, () => {
    hookInstaller.uninstall();
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS, () => {
    return hookInstaller.isInstalled();
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_POSITION_GET, () => {
    return copilotWindow.getPosition();
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_POSITION_SET,
    (_event, pos: { x: number; y: number }) => {
      copilotWindow.setPosition(pos.x, pos.y);
    }
  );

  ipcMain.on('copilot:set-expanded', (_event, expanded: boolean) => {
    copilotWindow.setExpanded(expanded);
  });

  log.info('IPC handlers registered');
}
