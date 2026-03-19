export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
};

export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type?: 'terminal' | 'star-command' | 'crew' | 'file' | 'image';
  avatarVariant?: string;
  splitRoot: PaneNode;
};

export type PaneNode = PaneSplit | PaneLeaf;

export type PaneSplit = {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number;
  children: [PaneNode, PaneNode];
};

export type PaneLeaf = {
  type: 'leaf';
  id: string;
  ptyPid?: number;
  shell?: string;
  cwd: string;
  paneType?: 'terminal' | 'file' | 'image';
  filePath?: string;
  isDirty?: boolean;
  serializedContent?: string;
};

export type NotificationLevel = 'permission' | 'error' | 'info' | 'subtle';

// Called NotificationEvent (not NotificationState as in spec) to distinguish
// the IPC transport event from any persistent state. Maps 1:1 to spec's NotificationState.
export type NotificationEvent = {
  paneId: string;
  level: NotificationLevel;
  timestamp: number;
};

export type AgentVisualState = {
  paneId: string;
  label: string;
  state: 'working' | 'reading' | 'idle' | 'walking' | 'needs-permission' | 'waiting' | 'not-agent';
  currentTool?: string;
  subAgents: AgentVisualState[];
  uptime: number;
};

export type FontSelection =
  | { type: 'bundled'; name: 'JetBrains Mono Nerd Font' }
  | { type: 'custom'; name: string };

/** Resolve a FontSelection to the CSS font-family string used by xterm */
export function resolveFontFamily(sel: FontSelection): string {
  if (sel.type === 'bundled') {
    return `${sel.name}, Symbols Nerd Font, monospace`;
  }
  // Custom fonts still get Symbols Nerd Font fallback for Nerd glyphs
  return `${sel.name}, Symbols Nerd Font, monospace`;
}

export type VisualizerEffects = {
  nebulaClouds: boolean;
  shootingStars: boolean;
  twinklingStars: boolean;
  distantPlanets: boolean;
  auroraBands: boolean;
  constellationLines: boolean;
  coloredTrails: boolean;
  formationFlying: boolean;
  shipBadges: boolean;
  enhancedIdle: boolean;
  dayNightCycle: boolean;
  spaceWeather: boolean;
  asteroidField: boolean;
  spaceStation: boolean;
  ambientSound: boolean;
  followCamera: boolean;
  zoomEnabled: boolean;
  bloomGlow: boolean;
  starColorVariety: boolean;
  depthOfField: boolean;
};

export type FleetSettings = {
  general: {
    defaultShell: string;
    scrollbackSize: number;
    fontFamily: string;
    fontSize: number;
    theme: 'dark' | 'light';
  };
  notifications: {
    taskComplete: { badge: boolean; sound: boolean; os: boolean };
    needsPermission: { badge: boolean; sound: boolean; os: boolean };
    processExitError: { badge: boolean; sound: boolean; os: boolean };
    processExitClean: { badge: boolean; sound: boolean; os: boolean };
    comms: { badge: boolean; sound: boolean; os: boolean };
    memos: { badge: boolean; sound: boolean; os: boolean };
  };
  socketApi: {
    enabled: boolean;
    socketPath: string;
  };
  visualizer: {
    panelMode: 'drawer' | 'tab';
    effects: VisualizerEffects;
    soundVolume: number;
  };
};

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; releaseNotes: string; percent: number }
  | { state: 'ready'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'error'; message: string };
