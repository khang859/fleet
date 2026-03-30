import { createLogger } from '../logger';
import { CopilotSessionStore } from './session-store';
import { CopilotSocketServer } from './socket-server';
import { CopilotWindow } from './copilot-window';
import { ConversationReader } from './conversation-reader';
import { registerCopilotIpcHandlers } from './ipc-handlers';
import * as hookInstaller from './hook-installer';
import type { SettingsStore } from '../settings-store';
import type { BrowserWindow } from 'electron';
import type { PtyManager } from '../pty-manager';
import { IPC_CHANNELS } from '../../shared/constants';

const log = createLogger('copilot');

type CopilotServiceState = 'idle' | 'starting' | 'running' | 'stopping';

let sessionStore: CopilotSessionStore | null = null;
let socketServer: CopilotSocketServer | null = null;
let copilotWindow: CopilotWindow | null = null;
let conversationReader: ConversationReader | null = null;
let serviceState: CopilotServiceState = 'idle';
let cachedSettingsStore: SettingsStore | null = null;
/** Queued toggle to run after current transition completes */
let pendingToggle: boolean | null = null;
export async function initCopilot(
  settingsStore: SettingsStore,
  ptyManager: PtyManager,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
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
  registerCopilotIpcHandlers(sessionStore, socketServer, copilotWindow, settingsStore, conversationReader, ptyManager, getMainWindow, onCopilotSettingsChanged);

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
  const wantEnabled = settings.copilot.enabled;
  log.info('copilot settings changed', { enabled: wantEnabled, serviceState });

  // If currently transitioning, queue the desired state
  if (serviceState === 'starting' || serviceState === 'stopping') {
    pendingToggle = wantEnabled;
    log.info('queued toggle (transition in progress)', { pendingToggle });
    return;
  }

  if (wantEnabled && serviceState === 'idle') {
    await startCopilotServices();
  } else if (!wantEnabled && serviceState === 'running') {
    await stopCopilotServices();
  }
}

async function drainPendingToggle(): Promise<void> {
  if (pendingToggle === null) return;
  const wantEnabled = pendingToggle;
  pendingToggle = null;
  log.info('draining pending toggle', { wantEnabled, serviceState });

  if (wantEnabled && serviceState === 'idle') {
    await startCopilotServices();
  } else if (!wantEnabled && serviceState === 'running') {
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

  serviceState = 'starting';
  log.info('starting copilot services');

  conversationReader?.setOnChange((sessionId, messages) => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_CHAT_UPDATED, { sessionId, messages });
  });

  sessionStore.setOnChange(() => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_SESSIONS, sessionStore!.getSessions());

    if (conversationReader) {
      const activeSessions = sessionStore!.getSessions();
      const activeIds = new Set(activeSessions.map(s => s.sessionId));

      for (const watchedId of conversationReader.getWatchedSessionIds()) {
        if (activeIds.has(watchedId)) {
          conversationReader.refresh(watchedId);
        } else {
          conversationReader.unwatch(watchedId);
        }
      }
    }
  });

  // Hook installation failure should not prevent copilot from starting —
  // the socket server and window are still useful for manual hook install later
  if (!hookInstaller.isInstalled()) {
    try {
      log.info('installing hooks');
      hookInstaller.install();
    } catch (err) {
      log.error('failed to install hooks', { error: String(err) });
    }
  } else {
    try {
      hookInstaller.syncScript();
    } catch (err) {
      log.error('failed to sync hook script', { error: String(err) });
    }
  }

  try {
    log.info('starting socket server');
    await socketServer.start();
  } catch (err) {
    log.error('failed to start socket server', { error: String(err) });
    serviceState = 'idle';
    await drainPendingToggle();
    return;
  }

  try {
    log.info('creating copilot window');
    copilotWindow.create();
  } catch (err) {
    log.error('failed to create copilot window', { error: String(err) });
    // Socket is running but window failed — stop socket too
    await socketServer.stop();
    serviceState = 'idle';
    await drainPendingToggle();
    return;
  }

  serviceState = 'running';
  log.info('copilot started successfully');
  await drainPendingToggle();
}

async function stopCopilotServices(): Promise<void> {
  serviceState = 'stopping';
  log.info('stopping copilot services');

  if (socketServer) {
    try {
      await socketServer.stop();
    } catch (err) {
      log.error('error stopping socket server', { error: String(err) });
    }
  }
  if (copilotWindow) {
    try {
      copilotWindow.destroy();
    } catch (err) {
      log.error('error destroying copilot window', { error: String(err) });
    }
  }
  if (conversationReader) {
    try {
      conversationReader.dispose();
    } catch (err) {
      log.error('error disposing conversation reader', { error: String(err) });
    }
  }
  if (sessionStore) {
    sessionStore.clear();
  }

  serviceState = 'idle';
  log.info('copilot services stopped');
  await drainPendingToggle();
}

export async function stopCopilot(): Promise<void> {
  await stopCopilotServices();
}

/** Remove copilot sessions whose PID is no longer alive. */
export function pruneDeadCopilotSessions(): void {
  sessionStore?.pruneDeadSessions();
}
