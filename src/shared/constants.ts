import { join } from 'path';
import { homedir } from 'os';
import type { FleetSettings } from './types';
import { DEFAULT_SCROLLBACK, DEFAULT_TERMINAL_BACKGROUND } from './types';
import {
  DEFAULT_ACCENT_COLOR_ID,
  DEFAULT_APP_THEME,
  DEFAULT_TERMINAL_THEME_ID
} from './theme-presets';
import { DEFAULT_TOOL_VISIBILITY } from './tools';
import { DEFAULT_AI_SETTINGS } from './agent-types';
export { IPC_CHANNELS } from './ipc-channels';

// --- Main-process only (Node.js built-ins) ---
// Do NOT import these from renderer code.

export const IS_FLEET_DEV = !!process.env.FLEET_DEV;

const suffix = IS_FLEET_DEV ? '-dev' : '';

export const SOCKET_PATH =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\fleet${suffix}`
    : join(homedir(), '.fleet', `fleet${suffix}.sock`);

export const COPILOT_SOCKET_PATH =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\fleet-copilot${suffix}`
    : join(homedir(), '.fleet', `fleet-copilot${suffix}.sock`);

export const DEFAULT_SETTINGS: FleetSettings = {
  general: {
    defaultShell: '',
    defaultShellProfileId: '',
    scrollbackSize: DEFAULT_SCROLLBACK,
    fontFamily: 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    fontSize: 14,
    theme: DEFAULT_APP_THEME,
    terminalTheme: DEFAULT_TERMINAL_THEME_ID,
    accentColor: DEFAULT_ACCENT_COLOR_ID,
    terminalBackground: DEFAULT_TERMINAL_BACKGROUND
  },
  notifications: {
    taskComplete: { badge: true, sound: false, os: false },
    needsPermission: { badge: true, sound: true, os: true },
    processExitError: { badge: true, sound: false, os: false },
    processExitClean: { badge: false, sound: false, os: false }
  },
  socketApi: {
    enabled: true,
    socketPath: ''
  },
  visualizer: {
    panelMode: 'drawer' as const,
    effects: {
      nebulaClouds: true,
      shootingStars: true,
      twinklingStars: true,
      distantPlanets: false,
      auroraBands: false,
      constellationLines: false,
      coloredTrails: true,
      formationFlying: false,
      shipBadges: true,
      enhancedIdle: true,
      dayNightCycle: false,
      spaceWeather: false,
      asteroidField: false,
      spaceStation: false,
      ambientSound: false,
      followCamera: false,
      zoomEnabled: true,
      bloomGlow: false,
      starColorVariety: true,
      depthOfField: false
    },
    soundVolume: 0.3
  },
  copilot: {
    enabled: false,
    spriteSheet: 'officer',
    notificationSound: 'Pop',
    autoStart: false,
    claudeConfigDir: '',
    workspaceOverrides: {},
    showAllWorkspaces: false
  },
  annotate: {
    retentionDays: 3
  },
  tools: DEFAULT_TOOL_VISIBILITY,
  ai: DEFAULT_AI_SETTINGS,
  remoteSsh: { hosts: [], rcConsent: {} }
};
