import { ipcMain, type BrowserWindow } from 'electron';
import { execSync } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { CopilotWindow } from './copilot-window';
import type { SettingsStore } from '../settings-store';
import type { ConversationReader } from './conversation-reader';
import type { ClaudeSessionsService } from '../claude-sessions';
import * as hookInstaller from '../claude-sessions/hook-installer';
import { transcriptPathFor } from '../claude-sessions/transcript-path';

const log = createLogger('copilot:ipc');

function isClaudeInstalled(): boolean {
  try {
    execSync('claude --version', { timeout: 3000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function registerCopilotIpcHandlers(
  claudeSessions: ClaudeSessionsService,
  copilotWindow: CopilotWindow,
  settingsStore: SettingsStore,
  conversationReader: ConversationReader,
  getMainWindow: () => BrowserWindow | null,
  onSettingsChanged?: () => Promise<void>
): void {
  const registry = claudeSessions.registry;

  ipcMain.handle(IPC_CHANNELS.COPILOT_SESSIONS, () => {
    return registry.list();
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_RESPOND_PERMISSION,
    (_event, args: { toolUseId: string; decision: 'allow' | 'deny'; reason?: string }) => {
      log.info('permission response', { toolUseId: args.toolUseId, decision: args.decision });
      return claudeSessions.respondToPermission(args.toolUseId, args.decision, args.reason);
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

  ipcMain.handle(IPC_CHANNELS.COPILOT_SERVICE_STATUS, () => {
    const settings = settingsStore.get();
    const configDir = settings.copilot.claudeConfigDir || undefined;
    return {
      hookInstalled: hookInstaller.isInstalled(configDir),
      claudeDetected: isClaudeInstalled()
    };
  });

  // Active workspace: push from main renderer → copilot window, pull for initial load
  let lastActiveWorkspace: { workspaceId: string; workspaceName: string } | null = null;

  ipcMain.on(
    IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE,
    (_event, payload: { workspaceId: string; workspaceName: string }) => {
      lastActiveWorkspace = payload;
      copilotWindow.send(IPC_CHANNELS.COPILOT_ACTIVE_WORKSPACE, payload);
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPILOT_GET_ACTIVE_WORKSPACE, () => {
    return lastActiveWorkspace;
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_POSITION_GET, () => {
    return copilotWindow.getPosition();
  });

  ipcMain.handle(IPC_CHANNELS.COPILOT_POSITION_SET, (_event, pos: { x: number; y: number }) => {
    copilotWindow.setPosition(pos.x, pos.y);
  });

  ipcMain.on('copilot:toggle-expanded', () => {
    copilotWindow.toggleExpanded();
  });

  ipcMain.on('copilot:set-expanded', (_event, expanded: boolean) => {
    copilotWindow.setExpanded(expanded);
  });

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_CHAT_HISTORY,
    (_event, args: { sessionId: string; cwd: string }) => {
      const session = registry.get(args.sessionId);
      const filePath = transcriptPathFor(
        session ?? {
          sessionId: args.sessionId,
          cwd: args.cwd,
          transcriptPath: null,
          configDir: null
        }
      );
      const messages = conversationReader.getMessages(args.sessionId, filePath);
      conversationReader.watch(args.sessionId, filePath);
      return messages;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.COPILOT_SEND_MESSAGE,
    async (_event, args: { sessionId: string; message: string }) => {
      // The chat answers a question dialog with an option number, a key press.
      const session = registry.get(args.sessionId);
      if (session?.waitingKind === 'question') {
        return claudeSessions.answerQuestion(args.sessionId, args.message);
      }
      const result = await claudeSessions.sendPrompt(args.sessionId, args.message, 'user');
      if (!result.ok) {
        log.warn('message not sent', { sessionId: args.sessionId, reason: result.reason });
        return false;
      }
      log.info('message sent', { sessionId: args.sessionId, confirmed: result.confirmed });
      return true;
    }
  );

  ipcMain.handle(IPC_CHANNELS.COPILOT_FOCUS_TERMINAL, (_event, args: { sessionId: string }) => {
    const session = registry.get(args.sessionId);
    if (!session) {
      log.warn('unknown session, cannot focus terminal', { sessionId: args.sessionId });
      return false;
    }
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
      win.webContents.send('fleet:focus-pane', { paneId: session.paneId });
      log.info('focused terminal pane', { sessionId: args.sessionId, paneId: session.paneId });
    }
    copilotWindow.setExpanded(false);
    return true;
  });

  log.info('IPC handlers registered');
}
