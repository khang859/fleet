import { ipcMain, type BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { CopilotSessionStore } from './session-store';
import type { CopilotSocketServer } from './socket-server';
import type { CopilotWindow } from './copilot-window';
import type { SettingsStore } from '../settings-store';
import type { LayoutStore } from '../layout-store';
import type { ConversationReader } from './conversation-reader';
import type { PtyManager } from '../pty-manager';
import * as hookInstaller from './hook-installer';

const log = createLogger('copilot:ipc');

function isClaudeInstalled(): boolean {
  try {
    execSync('claude --version', { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

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
  layoutStore: LayoutStore,
  getMainWindow: () => BrowserWindow | null,
  onSettingsChanged?: () => Promise<void>
): void {
  // Wire up workspace resolution: PID → paneId → workspaceId
  socketServer.setWorkspaceResolver((pid: number) => {
    const paneId = findPaneForPid(ptyManager, pid);
    if (!paneId) return null;
    return layoutStore.findWorkspaceForPane(paneId);
  });

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
    const settings = settingsStore.get();
    const configDir = settings.copilot.claudeConfigDir || undefined;
    hookInstaller.install(configDir);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS, () => {
    const settings = settingsStore.get();
    const configDir = settings.copilot.claudeConfigDir || undefined;
    hookInstaller.uninstall(configDir);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS, () => {
    const settings = settingsStore.get();
    const configDir = settings.copilot.claudeConfigDir || undefined;
    return hookInstaller.isInstalled(configDir);
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, (_event, configDir: string) => {
    log.debug('ipc:copilot:install-hooks-to', { configDir });
    hookInstaller.install(configDir);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS_FROM, (_event, configDir: string) => {
    log.debug('ipc:copilot:uninstall-hooks-from', { configDir });
    hookInstaller.uninstall(configDir);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, (_event, configDir: string) => {
    return hookInstaller.isInstalled(configDir);
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_SERVICE_STATUS, () => {
    const settings = settingsStore.get();
    const configDir = settings.copilot.claudeConfigDir || undefined;
    return {
      hookInstalled: hookInstaller.isInstalled(configDir),
      claudeDetected: isClaudeInstalled(),
    };
  });

  // Active workspace: push from main renderer → copilot window, pull for initial load
  let lastActiveWorkspace: { workspaceId: string; workspaceName: string } | null = null;

  ipcMain.on(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, (
    _event,
    payload: { workspaceId: string; workspaceName: string }
  ) => {
    lastActiveWorkspace = payload;
    copilotWindow.send(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, payload);
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_GET_ACTIVE_WORKSPACE, () => {
    return lastActiveWorkspace;
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

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_FOCUS_TERMINAL,
    (_event, args: { sessionId: string }) => {
      const session = sessionStore.getSession(args.sessionId);
      if (!session?.pid) {
        log.warn('no PID for session, cannot focus terminal', { sessionId: args.sessionId });
        return false;
      }
      const paneId = findPaneForPid(ptyManager, session.pid);
      if (!paneId) {
        log.warn('no Fleet pane found for session', { sessionId: args.sessionId, pid: session.pid });
        return false;
      }
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
        win.webContents.send('fleet:focus-pane', { paneId });
        log.info('focused terminal pane', { sessionId: args.sessionId, paneId });
      }
      copilotWindow.setExpanded(false);
      return true;
    }
  );

  log.info('IPC handlers registered');
}
