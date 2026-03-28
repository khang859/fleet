import { ipcMain } from 'electron';
import { openSync, writeSync, closeSync } from 'fs';
import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { CopilotSessionStore } from './session-store';
import type { CopilotSocketServer } from './socket-server';
import type { CopilotWindow } from './copilot-window';
import type { SettingsStore } from '../settings-store';
import type { ConversationReader } from './conversation-reader';
import * as hookInstaller from './hook-installer';

const log = createLogger('copilot:ipc');

export function registerCopilotIpcHandlers(
  sessionStore: CopilotSessionStore,
  socketServer: CopilotSocketServer,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore,
  conversationReader: ConversationReader,
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

  ipcMain.on('copilot:toggle-expanded', () => {
    copilotWindow.toggleExpanded();
  });

  ipcMain.on('copilot:set-expanded', (_event, expanded: boolean) => {
    copilotWindow.setExpanded(expanded);
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_CHAT_HISTORY,
    (_event, args: { sessionId: string; cwd: string }) => {
      const messages = conversationReader.getMessages(args.sessionId, args.cwd);
      conversationReader.watch(args.sessionId, args.cwd);
      return messages;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_SEND_MESSAGE,
    (_event, args: { sessionId: string; message: string }) => {
      const session = sessionStore.getSession(args.sessionId);
      if (!session?.tty) {
        log.warn('no TTY for session, cannot send message', { sessionId: args.sessionId });
        return false;
      }
      try {
        const fd = openSync(session.tty, 'w');
        try {
          writeSync(fd, args.message + '\n');
        } finally {
          closeSync(fd);
        }
        log.info('message sent to TTY', { sessionId: args.sessionId, tty: session.tty });
        return true;
      } catch (err) {
        log.error('failed to send message', { error: String(err) });
        return false;
      }
    }
  );

  log.info('IPC handlers registered');
}
