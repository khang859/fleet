import { join } from 'path';
import { homedir } from 'os';
import type { FleetSettings } from './types';

export const IPC_CHANNELS = {
  PTY_CREATE: 'pty:create',
  PTY_DATA: 'pty:data',
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_EXIT: 'pty:exit',
  LAYOUT_SAVE: 'layout:save',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_LIST: 'layout:list',
  LAYOUT_DELETE: 'layout:delete',
  NOTIFICATION: 'notification',
  PANE_FOCUSED: 'pane:focused',
  AGENT_STATE: 'agent:state',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
} as const;

export const DEFAULT_SCROLLBACK = 10_000;

// --- Main-process only (Node.js built-ins) ---
// Do NOT import these from renderer code.

export const SOCKET_PATH =
  process.platform === 'win32'
    ? '\\\\.\\pipe\\fleet'
    : join(homedir(), '.fleet', 'fleet.sock');

export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export const DEFAULT_SETTINGS: FleetSettings = {
  general: {
    defaultShell: '',
    scrollbackSize: DEFAULT_SCROLLBACK,
    fontFamily: 'monospace',
    fontSize: 14,
    theme: 'dark',
  },
  notifications: {
    taskComplete: { badge: true, sound: false, os: false },
    needsPermission: { badge: true, sound: true, os: true },
    processExitError: { badge: true, sound: false, os: false },
    processExitClean: { badge: false, sound: false, os: false },
  },
  socketApi: {
    enabled: true,
    socketPath: '',
  },
  visualizer: {
    panelMode: 'drawer',
  },
};
