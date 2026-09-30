import { createLogger } from '../logger';
import { CopilotWindow } from './copilot-window';
import { ConversationReader } from './conversation-reader';
import { registerCopilotIpcHandlers } from './ipc-handlers';
import type { SettingsStore } from '../settings-store';
import type { BrowserWindow } from 'electron';
import type { ClaudeSessionsService } from '../claude-sessions';
import { IPC_CHANNELS } from '../../shared/constants';

const log = createLogger('copilot');

type CopilotServiceState = 'idle' | 'starting' | 'running' | 'stopping';

let claudeSessions: ClaudeSessionsService | null = null;
let copilotWindow: CopilotWindow | null = null;
let conversationReader: ConversationReader | null = null;
let unsubscribe: (() => void) | null = null;
/** Withdraws the copilot as an answerer of permission requests. */
let stopAnswering: (() => void) | null = null;
let serviceState: CopilotServiceState = 'idle';
let cachedSettingsStore: SettingsStore | null = null;
/** Queued toggle to run after current transition completes */
let pendingToggle: boolean | null = null;

/**
 * The copilot mascot: a macOS overlay showing the sessions the Claude session
 * registry tracks. Tracking itself runs without it, on every platform.
 */
export async function initCopilot(
  settingsStore: SettingsStore,
  sessions: ClaudeSessionsService,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  log.info('initCopilot called', { platform: process.platform });

  if (process.platform !== 'darwin') {
    log.info('copilot disabled: not macOS');
    return;
  }

  cachedSettingsStore = settingsStore;
  claudeSessions = sessions;
  copilotWindow = new CopilotWindow();
  conversationReader = new ConversationReader();
  registerCopilotIpcHandlers(
    sessions,
    copilotWindow,
    settingsStore,
    conversationReader,
    getMainWindow,
    onCopilotSettingsChanged
  );

  const settings = settingsStore.get();
  log.info('copilot settings', {
    enabled: settings.copilot.enabled,
    autoStart: settings.copilot.autoStart
  });

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
  if (!claudeSessions || !copilotWindow) {
    log.error('startCopilotServices: missing dependencies');
    return;
  }

  serviceState = 'starting';
  log.info('starting copilot services');

  conversationReader?.setOnChange((sessionId, messages) => {
    copilotWindow?.send(IPC_CHANNELS.COPILOT_CHAT_UPDATED, { sessionId, messages });
  });

  const registry = claudeSessions.registry;
  unsubscribe = registry.subscribe(() => {
    const sessions = registry.list();
    copilotWindow?.send(IPC_CHANNELS.COPILOT_SESSIONS, sessions);

    if (conversationReader) {
      const activeIds = new Set(sessions.map((s) => s.sessionId));
      for (const watchedId of conversationReader.getWatchedSessionIds()) {
        if (activeIds.has(watchedId)) {
          conversationReader.refresh(watchedId);
        } else {
          conversationReader.unwatch(watchedId);
        }
      }
    }
  });

  try {
    log.info('creating copilot window');
    copilotWindow.create();
  } catch (err) {
    log.error('failed to create copilot window', { error: String(err) });
    unsubscribe();
    unsubscribe = null;
    serviceState = 'idle';
    await drainPendingToggle();
    return;
  }

  stopAnswering = claudeSessions.addPermissionAnswerer();
  serviceState = 'running';
  log.info('copilot started successfully');
  await drainPendingToggle();
}

async function stopCopilotServices(): Promise<void> {
  serviceState = 'stopping';
  log.info('stopping copilot services');

  unsubscribe?.();
  unsubscribe = null;
  stopAnswering?.();
  stopAnswering = null;
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

  serviceState = 'idle';
  log.info('copilot services stopped');
  await drainPendingToggle();
}

export async function stopCopilot(): Promise<void> {
  await stopCopilotServices();
}
