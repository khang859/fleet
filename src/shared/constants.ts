import { join } from 'path';
import { homedir } from 'os';
import type { FleetSettings } from './types';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  DEFAULT_TERMINAL_BACKGROUND,
  ORCHESTRATOR_PROFILE_NAME
} from './types';
import {
  DEFAULT_ACCENT_COLOR_ID,
  DEFAULT_APP_THEME,
  DEFAULT_TERMINAL_THEME_ID
} from './theme-presets';
import { DEFAULT_TOOL_VISIBILITY } from './tools';
import { DEFAULT_AI_SETTINGS } from './chat-types';
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
  sessions: {
    preferredAgent: 'rune'
  },
  tools: DEFAULT_TOOL_VISIBILITY,
  kanban: {
    dispatcher: {
      intervalMs: 5000,
      maxInProgress: 3,
      failureLimit: 3,
      claimTtlMs: 900_000,
      autoDecompose: false,
      maxDecompose: 1,
      autoAssign: true,
      autoIntegrate: true,
      autoReview: true
    },
    pm: {
      autopilotEnabled: false,
      eventMinGapMs: 30_000,
      coalesceWindowMs: 2_000
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
      },
      {
        name: 'explorer',
        role: 'explorer',
        model: '',
        skills: [],
        instructions:
          'You are a read-only cartographer. Map the files, modules, and patterns affected by the ' +
          'task; surface risks and unknowns. Never write code. Register your findings as a ' +
          'kanban_artifact and post a one-paragraph summary on the root task, then call kanban_complete.'
      },
      {
        name: 'architect',
        role: 'architect',
        model: '',
        skills: [],
        instructions:
          'You are the architect. Consume the explore findings, write a concrete implementation spec, ' +
          'then emit the implementation work by calling kanban_create once per unit (capped). Do not ' +
          'implement anything yourself. Call kanban_complete with a plan summary when the fan-out is done.'
      },
      {
        name: 'reviewer',
        role: 'reviewer',
        model: '',
        skills: ['requesting-code-review'],
        instructions:
          'You are an independent code reviewer, distinct from the implementer (prefer a different model ' +
          'to counter self-preference bias). Judge the diff against the task goal and acceptance criteria; ' +
          'call kanban_review_verdict with approve or request_changes plus specific findings.'
      },
      {
        name: 'qa',
        role: 'qa',
        model: '',
        skills: [],
        instructions:
          'You are feature-level QA. Validate the whole feature against acceptance criteria using ' +
          'execution (run the project verify commands and exercise behavior), not a re-read of diffs. ' +
          'Emit your verdict with kanban_qa_verdict: pass or request_changes.'
      }
    ]
  },
  ai: DEFAULT_AI_SETTINGS
};
