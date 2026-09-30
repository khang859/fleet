import { IPC_CHANNELS } from '../../shared/constants';
import { createLogger } from '../logger';
import type { ClaudeSessionsSnapshot } from '../../shared/claude-sessions';
import * as hookInstaller from './hook-installer';

const log = createLogger('claude-sessions:ipc');

/**
 * The part of Electron's `ipcMain` this module uses. Taken as a parameter so
 * the module stays free of Electron and runs under plain Node in tests.
 */
export type IpcRegistrar = {
  handle(channel: string, listener: (event: unknown, arg: unknown) => unknown): void;
};

function folderArg(arg: unknown): string {
  if (typeof arg !== 'string' || arg.trim() === '') throw new Error('Expected a folder path');
  return arg;
}

/**
 * The status view's snapshot, and hook install, remove and status for one
 * Claude config folder, on every platform.
 */
export function registerClaudeSessionsIpc(
  ipc: IpcRegistrar,
  snapshot: () => ClaudeSessionsSnapshot
): void {
  ipc.handle(IPC_CHANNELS.CLAUDE_SESSIONS_LIST, () => snapshot());

  ipc.handle(IPC_CHANNELS.COPILOT_INSTALL_HOOKS_TO, (_event, arg) => {
    const configDir = folderArg(arg);
    log.debug('install hooks', { configDir });
    hookInstaller.install(configDir);
    return true;
  });

  ipc.handle(IPC_CHANNELS.COPILOT_UNINSTALL_HOOKS_FROM, (_event, arg) => {
    const configDir = folderArg(arg);
    log.debug('uninstall hooks', { configDir });
    hookInstaller.uninstall(configDir);
    return true;
  });

  ipc.handle(IPC_CHANNELS.COPILOT_HOOK_STATUS_FOR, (_event, arg) =>
    hookInstaller.hookStatus(folderArg(arg))
  );
}
