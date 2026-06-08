import { join } from 'path';
import { homedir } from 'os';
import type { FleetSettings } from './types';
import { DEFAULT_ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_PROFILE_NAME } from './types';
import {
  DEFAULT_ACCENT_COLOR_ID,
  DEFAULT_APP_THEME,
  DEFAULT_TERMINAL_THEME_ID
} from './theme-presets';
export { IPC_CHANNELS } from './ipc-channels';

const DEFAULT_SCROLLBACK = 10_000;

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
    terminalBackground: {
      imagePath: null,
      opacity: 0.15,
      blur: 0,
      edgeFadeX: 0,
      edgeFadeY: 0,
      fit: 'cover'
    }
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
    autoEnabled: false,
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
  kanban: {
    dispatcher: {
      intervalMs: 5000,
      maxInProgress: 3,
      failureLimit: 3,
      claimTtlMs: 900_000,
      autoDecompose: false,
      maxDecompose: 1
    },
    defaults: { workspaceKind: 'scratch', maxRuntimeSeconds: null },
    artifactRetentionDays: 14,
    notifications: {
      blocked: { os: true, badge: true },
      failed: { os: true, badge: true },
      completed: { os: true, badge: true },
      scheduleFired: { os: true, badge: true }
    },
    profiles: [
      {
        name: 'default',
        role: 'worker',
        model: '',
        skills: [],
        instructions:
          'You are a focused Fleet worker. Complete the assigned kanban task end-to-end, then call kanban_complete with a concise result. If you cannot proceed, call kanban_block with the reason.'
      },
      {
        name: ORCHESTRATOR_PROFILE_NAME,
        role: 'orchestrator',
        model: '',
        skills: [],
        instructions: DEFAULT_ORCHESTRATOR_INSTRUCTIONS
      }
    ]
  }
};
