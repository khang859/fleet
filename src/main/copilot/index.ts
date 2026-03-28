import { createLogger } from '../logger';
import { CopilotSessionStore } from './session-store';
import { CopilotSocketServer } from './socket-server';
import { CopilotWindow } from './copilot-window';
import { registerCopilotIpcHandlers } from './ipc-handlers';
import * as hookInstaller from './hook-installer';
import type { SettingsStore } from '../settings-store';
import { IPC_CHANNELS } from '../../shared/constants';

const log = createLogger('copilot');

let sessionStore: CopilotSessionStore | null = null;
let socketServer: CopilotSocketServer | null = null;
let copilotWindow: CopilotWindow | null = null;

export async function initCopilot(settingsStore: SettingsStore): Promise<void> {
  if (process.platform !== 'darwin') {
    log.info('copilot disabled: not macOS');
    return;
  }

  sessionStore = new CopilotSessionStore();
  socketServer = new CopilotSocketServer(sessionStore);
  copilotWindow = new CopilotWindow();
  registerCopilotIpcHandlers(sessionStore, socketServer, copilotWindow, settingsStore);

  const settings = settingsStore.get();
  if (!settings.copilot.enabled) {
    log.info('copilot disabled by settings (IPC handlers registered for settings UI)');
    return;
  }

  await startCopilotServices();
}

async function startCopilotServices(): Promise<void> {
  if (!sessionStore || !socketServer || !copilotWindow) return;

  sessionStore.setOnChange(() => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_SESSIONS, sessionStore!.getSessions());
  });

  if (!hookInstaller.isInstalled()) {
    try {
      hookInstaller.install();
    } catch (err) {
      log.error('failed to install hooks', { error: String(err) });
    }
  }

  try {
    await socketServer.start();
  } catch (err) {
    log.error('failed to start socket server', { error: String(err) });
    return;
  }

  copilotWindow.create();
  log.info('copilot started');
}

export async function stopCopilot(): Promise<void> {
  if (socketServer) {
    await socketServer.stop();
  }
  if (copilotWindow) {
    copilotWindow.destroy();
  }
  log.info('copilot stopped');
}
