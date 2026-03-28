import { createLogger } from '../logger';
import { CopilotSessionStore } from './session-store';
import { CopilotSocketServer } from './socket-server';
import { CopilotWindow } from './copilot-window';
import { ConversationReader } from './conversation-reader';
import { registerCopilotIpcHandlers } from './ipc-handlers';
import * as hookInstaller from './hook-installer';
import type { SettingsStore } from '../settings-store';
import { IPC_CHANNELS } from '../../shared/constants';

const log = createLogger('copilot');

let sessionStore: CopilotSessionStore | null = null;
let socketServer: CopilotSocketServer | null = null;
let copilotWindow: CopilotWindow | null = null;
let conversationReader: ConversationReader | null = null;
let servicesRunning = false;
let cachedSettingsStore: SettingsStore | null = null;

export async function initCopilot(settingsStore: SettingsStore): Promise<void> {
  log.info('initCopilot called', { platform: process.platform });

  if (process.platform !== 'darwin') {
    log.info('copilot disabled: not macOS');
    return;
  }

  cachedSettingsStore = settingsStore;
  sessionStore = new CopilotSessionStore();
  socketServer = new CopilotSocketServer(sessionStore);
  copilotWindow = new CopilotWindow();
  conversationReader = new ConversationReader();
  registerCopilotIpcHandlers(sessionStore, socketServer, copilotWindow, settingsStore, conversationReader, onCopilotSettingsChanged);

  const settings = settingsStore.get();
  log.info('copilot settings', { enabled: settings.copilot.enabled, autoStart: settings.copilot.autoStart });

  if (!settings.copilot.enabled) {
    log.info('copilot disabled by settings (IPC handlers registered for settings UI)');
    return;
  }

  await startCopilotServices();
}

/** Called from IPC when user toggles copilot enabled in settings */
export async function onCopilotSettingsChanged(): Promise<void> {
  if (!cachedSettingsStore) return;
  const settings = cachedSettingsStore.get();
  log.info('copilot settings changed', { enabled: settings.copilot.enabled, servicesRunning });

  if (settings.copilot.enabled && !servicesRunning) {
    await startCopilotServices();
  } else if (!settings.copilot.enabled && servicesRunning) {
    await stopCopilotServices();
  }
}

async function startCopilotServices(): Promise<void> {
  if (!sessionStore || !socketServer || !copilotWindow) {
    log.error('startCopilotServices: missing dependencies', {
      hasSessionStore: !!sessionStore,
      hasSocketServer: !!socketServer,
      hasCopilotWindow: !!copilotWindow,
    });
    return;
  }

  log.info('starting copilot services');

  conversationReader?.setOnChange((sessionId, messages) => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_CHAT_UPDATED, { sessionId, messages });
  });

  sessionStore.setOnChange(() => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_SESSIONS, sessionStore!.getSessions());

    // Clean up watchers for ended sessions
    if (conversationReader) {
      const activeIds = new Set(sessionStore!.getSessions().map(s => s.sessionId));
      for (const watchedId of conversationReader.getWatchedSessionIds()) {
        if (!activeIds.has(watchedId)) {
          conversationReader.unwatch(watchedId);
        }
      }
    }
  });

  if (!hookInstaller.isInstalled()) {
    try {
      log.info('installing hooks');
      hookInstaller.install();
    } catch (err) {
      log.error('failed to install hooks', { error: String(err) });
    }
  } else {
    log.info('hooks already installed');
  }

  try {
    log.info('starting socket server');
    await socketServer.start();
  } catch (err) {
    log.error('failed to start socket server', { error: String(err) });
    return;
  }

  log.info('creating copilot window');
  copilotWindow.create();
  servicesRunning = true;
  log.info('copilot started successfully');
}

async function stopCopilotServices(): Promise<void> {
  log.info('stopping copilot services');
  if (socketServer) {
    await socketServer.stop();
  }
  if (copilotWindow) {
    copilotWindow.destroy();
  }
  if (conversationReader) {
    conversationReader.dispose();
  }
  servicesRunning = false;
  log.info('copilot services stopped');
}

export async function stopCopilot(): Promise<void> {
  await stopCopilotServices();
}
