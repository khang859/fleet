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
  PTY_GC: 'pty:gc',
  PTY_CWD: 'pty:cwd',
  LAYOUT_SAVE: 'layout:save',
  LAYOUT_LOAD: 'layout:load',
  LAYOUT_LIST: 'layout:list',
  LAYOUT_DELETE: 'layout:delete',
  NOTIFICATION: 'notification',
  PANE_FOCUSED: 'pane:focused',
  AGENT_STATE: 'agent:state',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  GIT_IS_REPO: 'git:is-repo',
  GIT_STATUS: 'git:status',
  STARBASE_LIST_SECTORS: 'starbase:list-sectors',
  STARBASE_ADD_SECTOR: 'starbase:add-sector',
  STARBASE_REMOVE_SECTOR: 'starbase:remove-sector',
  STARBASE_UPDATE_SECTOR: 'starbase:update-sector',
  STARBASE_GET_CONFIG: 'starbase:get-config',
  STARBASE_SET_CONFIG: 'starbase:set-config',
  STARBASE_DEPLOY: 'starbase:deploy',
  STARBASE_RECALL: 'starbase:recall',
  STARBASE_CREW: 'starbase:crew',
  STARBASE_MISSIONS: 'starbase:missions',
  STARBASE_ADD_MISSION: 'starbase:add-mission',
  STARBASE_OBSERVE: 'starbase:observe',
  STARBASE_STATUS_UPDATE: 'starbase:status-update',
  STARBASE_COMMS_UNREAD: 'starbase:comms-unread',
  ADMIRAL_SEND: 'admiral:send-message',
  ADMIRAL_GET_HISTORY: 'admiral:get-history',
  ADMIRAL_RESET: 'admiral:reset',
  ADMIRAL_STREAM_CHUNK: 'admiral:stream-chunk',
  ADMIRAL_STREAM_END: 'admiral:stream-end',
  ADMIRAL_STREAM_ERROR: 'admiral:stream-error',
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
    fontFamily: 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
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
    effects: {
      nebulaClouds: true,
      shootingStars: true,
      twinklingStars: true,
      distantPlanets: true,
      auroraBands: true,
      constellationLines: true,
      coloredTrails: true,
      formationFlying: true,
      shipBadges: true,
      enhancedIdle: true,
      dayNightCycle: true,
      spaceWeather: true,
      asteroidField: true,
      spaceStation: true,
      ambientSound: false,
      followCamera: true,
      zoomEnabled: true,
      bloomGlow: true,
      starColorVariety: true,
      depthOfField: true,
    },
    soundVolume: 0.3,
  },
};
