import { join } from 'path';
import { homedir } from 'os';
import type { FleetSettings } from './types';
export { IPC_CHANNELS } from './ipc-channels';

export const DEFAULT_SCROLLBACK = 10_000;

// --- Main-process only (Node.js built-ins) ---
// Do NOT import these from renderer code.

export const SOCKET_PATH =
  process.platform === 'win32' ? '\\\\.\\pipe\\fleet' : join(homedir(), '.fleet', 'fleet.sock');

export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export const DEFAULT_SETTINGS: FleetSettings = {
  general: {
    defaultShell: '',
    scrollbackSize: DEFAULT_SCROLLBACK,
    fontFamily: 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    fontSize: 14,
    theme: 'dark'
  },
  notifications: {
    taskComplete: { badge: true, sound: false, os: false },
    needsPermission: { badge: true, sound: true, os: true },
    processExitError: { badge: true, sound: false, os: false },
    processExitClean: { badge: false, sound: false, os: false },
    comms: { badge: true, sound: false, os: true },
    memos: { badge: true, sound: false, os: true }
  },
  socketApi: {
    enabled: true,
    socketPath: ''
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
      depthOfField: true
    },
    soundVolume: 0.3
  }
};
