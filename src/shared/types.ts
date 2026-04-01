export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string;
  activePaneId?: string;
  collapsedGroups?: string[];
};

export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type?: 'terminal' | 'file' | 'image' | 'images' | 'settings';
  avatarVariant?: string;
  splitRoot: PaneNode;
  // Worktree group fields
  groupId?: string;
  groupRole?: 'parent' | 'worktree';
  groupLabel?: string;
  worktreeBranch?: string;
  worktreePath?: string;
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
  paneType?: 'terminal' | 'file' | 'image' | 'images';
  filePath?: string;
  isDirty?: boolean;
  serializedContent?: string;
};

export type NotificationLevel = 'permission' | 'error' | 'info' | 'subtle';

export type ActivityState = 'working' | 'idle' | 'done' | 'needs_me' | 'error';

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
  copilot: CopilotSettings;
};

// ── Copilot (Claude Code Session Monitor) ──────────────────────────────────

export type CopilotSessionPhase =
  | 'idle'
  | 'processing'
  | 'waitingForInput'
  | 'waitingForApproval'
  | 'compacting'
  | 'ended';

export type CopilotToolInfo = {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
};

export type CopilotPendingPermission = {
  sessionId: string;
  toolUseId: string;
  tool: CopilotToolInfo;
  receivedAt: number;
};

export type CopilotSession = {
  sessionId: string;
  cwd: string;
  projectName: string;
  phase: CopilotSessionPhase;
  pid?: number;
  tty?: string;
  workspaceId?: string;
  workspaceName?: string;
  pendingPermissions: CopilotPendingPermission[];
  lastActivity: number;
  createdAt: number;
};

export type CopilotWorkspaceOverride = {
  claudeConfigDir?: string;
};

export type CopilotSettings = {
  enabled: boolean;
  autoEnabled: boolean;
  spriteSheet: string;
  notificationSound: string;
  autoStart: boolean;
  claudeConfigDir: string;
  workspaceOverrides: Record<string, CopilotWorkspaceOverride>;
  showAllWorkspaces: boolean;
};

export type SpriteAnimation = {
  frames: number[];
  fps: number;
};

export type SpriteAnimations = Record<'idle' | 'processing' | 'permission' | 'complete', SpriteAnimation>;

export type MascotDefinition = {
  id: string;
  name: string;
  description: string;
  thumbnailFrame: number;
  animations?: SpriteAnimations;
};

export type CopilotPosition = {
  x: number;
  y: number;
  displayId: number;
};

// ── Copilot Chat Messages ────────────────────────────────────────────────────

export type CopilotMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; inputPreview: string; input?: Record<string, unknown> }
  | { type: 'thinking'; text: string }
  | { type: 'interrupted' };

export type CopilotChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  timestamp: string;
  blocks: CopilotMessageBlock[];
};

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; releaseNotes: string; percent: number }
  | { state: 'ready'; version: string; releaseNotes: string }
  | { state: 'not-available' }
  | { state: 'error'; message: string };

// ── Image Generation ────────────────────────────────────────────────────────

export type ImageGenerationStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'timeout';

export type ImageGenerationMode = 'generate' | 'edit' | `action:${string}`;

export type ImageFileEntry = {
  filename: string | null;
  width: number | null;
  height: number | null;
  error?: string;
  providerUrl?: string;
};

export type ImageGenerationMeta = {
  id: string;
  status: ImageGenerationStatus;
  createdAt: string;
  completedAt: string | null;
  failedAt: string | null;
  error: string | null;
  provider: string;
  model: string;
  mode: ImageGenerationMode;
  prompt: string;
  params: {
    resolution?: string;
    aspect_ratio?: string;
    output_format?: string;
    num_images?: number;
  };
  referenceImages: string[];
  images: ImageFileEntry[];
  providerRequestId: string | null;
  sourceImage: string | null;
};

export type ImageSettings = {
  defaultProvider: string;
  providers: Record<string, ImageProviderSettings>;
};

export type ImageActionSettings = {
  model?: string;
};

export type ImageProviderSettings = {
  apiKey: string;
  defaultModel: string;
  defaultResolution: string;
  defaultOutputFormat: string;
  defaultAspectRatio: string;
  actions?: Record<string, ImageActionSettings>;
};
