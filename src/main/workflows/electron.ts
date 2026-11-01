import type { BrowserWindow } from 'electron';
import { dialog, ipcMain, powerMonitor, powerSaveBlocker, safeStorage } from 'electron';
import { FLEET_HOME, IPC_CHANNELS, IS_FLEET_DEV } from '../../shared/constants';
import type { WorkflowProgram } from '../../shared/workflows';
import type { ActivityTracker } from '../activity-tracker';
import type { ClaudeSessionsService } from '../claude-sessions';
import { bundledExtensionPath } from '../claude-sessions/pi-extension';
import type { PaneOpener } from '../pane-opener';
import type { PtyManager } from '../pty-manager';
import { enrichProcessEnv } from '../shell-env';
import type { WorkflowsBridge } from './bridge-routes';
import { electronDialogs, registerWorkflowsIpc } from './ipc';
import { runProgram } from './pr';
import { WorkflowsService } from './index';

export type WorkflowsHost = {
  bridge: WorkflowsBridge;
  paneOpener: PaneOpener;
  ptyManager: PtyManager;
  activityTracker: ActivityTracker;
  claudeSessions: ClaudeSessionsService;
  getWindow: () => BrowserWindow | null;
};

async function hasProgram(program: WorkflowProgram): Promise<boolean> {
  // Spawned panes read the login PATH, so this must too.
  await enrichProcessEnv();
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    await runProgram(finder, [program], process.cwd());
    return true;
  } catch {
    return false;
  }
}

/** Build Workflows from Fleet's real parts. Everything Electron is here, so the rest can be tested. */
export function createWorkflows(host: WorkflowsHost): WorkflowsService {
  const { bridge, paneOpener, ptyManager, activityTracker, claudeSessions, getWindow } = host;

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const service = new WorkflowsService({
    home: FLEET_HOME,
    platform: process.platform,
    now: () => Date.now(),
    vault: safeStorage,
    power: { blocker: powerSaveBlocker, monitor: powerMonitor },
    bridge,
    openPane: async ({ paneId, cwd, line }) => {
      const shell = process.platform === 'win32' ? 'powershell.exe' : undefined;
      await paneOpener.open({ paneId, cwd, shell, typeOnStart: line, retain: true });
    },
    killPane: (paneId) => ptyManager.kill(paneId),
    paneCwd: (paneId) => ptyManager.getCwd(paneId),
    openFolders: () => ptyManager.paneIds().flatMap((paneId) => ptyManager.getCwd(paneId) ?? []),
    tokenOf: (paneId) => ptyManager.tokenOf(paneId),
    lastOutputAt: (paneId) => activityTracker.lastOutputAt(paneId),
    sendPrompt: async (sessionId, text) => (await claudeSessions.sendPrompt(sessionId, text)).ok,
    addPermissionAnswerer: () => claudeSessions.addPermissionAnswerer(),
    answerPermission: (toolUseId, decision, reason, mode) =>
      claudeSessions.respondToPermission(toolUseId, decision, reason, undefined, mode),
    subscribeSessions: (listener) => claudeSessions.registry.subscribe(listener),
    bridgeProblem: () =>
      claudeSessions.bridgeReady ? null : 'Session tracking is off, so agents cannot reach Fleet.',
    hasProgram,
    devExtension: IS_FLEET_DEV ? bundledExtensionPath() : null,
    onState: (state) => send(IPC_CHANNELS.WORKFLOWS_STATE, state),
    onEntries: (entries) => send(IPC_CHANNELS.WORKFLOWS_ENTRIES, entries),
    onTab: (tab) => send(IPC_CHANNELS.WORKFLOWS_TAB, tab)
  });

  ptyManager.onClosed((paneId, killed) => service.onPaneClosed(paneId, killed));
  registerWorkflowsIpc(ipcMain, service, electronDialogs(dialog, getWindow));
  return service;
}
