import { ipcMain } from 'electron';
import { execSync } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { CopilotSessionStore } from './session-store';
import type { CopilotSocketServer } from './socket-server';
import type { CopilotWindow } from './copilot-window';
import type { SettingsStore } from '../settings-store';
import type { ConversationReader } from './conversation-reader';
import type { PtyManager } from '../pty-manager';
import * as hookInstaller from './hook-installer';

const log = createLogger('copilot:ipc');

/**
 * Find the Fleet pane whose shell is the parent of the given PID.
 * Returns the paneId or null if no match found.
 */
function findPaneForPid(ptyManager: PtyManager, pid: number): string | null {
  const paneIds = ptyManager.paneIds();
  const ptyPids = paneIds.map(id => ({ paneId: id, pid: ptyManager.getPid(id) }));
  log.debug('findPaneForPid', { claudePid: pid, ptyPids });

  try {
    // Walk up the process tree to find which PTY shell is an ancestor
    let currentPid = pid;
    for (let depth = 0; depth < 5; depth++) {
      const ppid = parseInt(
        execSync(`ps -o ppid= -p ${currentPid}`, { timeout: 2000 }).toString().trim(),
        10
      );
      log.debug('ppid lookup', { currentPid, ppid, depth });
      if (isNaN(ppid) || ppid <= 1) break;

      for (const paneId of paneIds) {
        if (ptyManager.getPid(paneId) === ppid) {
          log.debug('found matching pane', { paneId, ppid, depth });
          return paneId;
        }
      }
      currentPid = ppid;
    }
  } catch (err) {
    log.error('findPaneForPid failed', { error: String(err) });
  }
  return null;
}

export function registerCopilotIpcHandlers(
  sessionStore: CopilotSessionStore,
  socketServer: CopilotSocketServer,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore,
  conversationReader: ConversationReader,
  ptyManager: PtyManager,
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
      if (!session?.pid) {
        log.warn('no PID for session, cannot send message', { sessionId: args.sessionId });
        return false;
      }
      const paneId = findPaneForPid(ptyManager, session.pid);
      if (!paneId) {
        log.warn('no Fleet pane found for session PID', { sessionId: args.sessionId, pid: session.pid });
        return false;
      }
      // Send text then carriage return (Enter), matching what terminal emulators send
      ptyManager.write(paneId, args.message + '\r');
      log.info('message sent via PTY master', { sessionId: args.sessionId, paneId, pid: session.pid });
      return true;
    }
  );

  log.info('IPC handlers registered');
}
