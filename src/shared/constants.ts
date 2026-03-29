import { join } from 'path';
import { homedir } from 'os';
import type { FleetSettings } from './types';
export { IPC_CHANNELS } from './ipc-channels';
export { MASCOT_REGISTRY } from './mascots';

export const DEFAULT_SCROLLBACK = 10_000;

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
    scrollbackSize: DEFAULT_SCROLLBACK,
    fontFamily: 'JetBrains Mono Nerd Font, Symbols Nerd Font, monospace',
    fontSize: 14,
    theme: 'dark'
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
  },
};
