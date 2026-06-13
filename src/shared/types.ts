import type { PathContext } from './shell-profiles';
import type { WorkspaceKind } from './kanban-types';
import type { KanbanNotifySettings } from './kanban-notifications';
import type { AccentColorId, AppThemeSelection, TerminalThemeId } from './theme-presets';
import type { SessionAgentFilter } from './sessions';
import type { ToolVisibility } from './tools';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? Array<U>
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string;
  activePaneId?: string;
  collapsedGroups?: string[];
  /** Pixel width of the expanded sidebar. Undefined = use DEFAULT_SIDEBAR_WIDTH. */
  sidebarWidth?: number;
};

export type Tab = {
  id: string;
  label: string;
  labelIsCustom: boolean;
  cwd: string;
  type?:
    | 'terminal'
    | 'file'
    | 'image'
    | 'images'
    | 'settings'
    | 'annotate'
    | 'pi'
    | 'markdown'
    | 'kanban'
    | 'artifacts'
    | 'pdf'
    | 'sessions';
  avatarVariant?: string;
  splitRoot: PaneNode;
  // Worktree group fields
  groupId?: string;
  groupRole?: 'parent' | 'worktree';
  groupLabel?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  /** ShellProfile id used when this tab was created. Optional for legacy persisted tabs. */
  shellProfileId?: string;
  /** Path semantics for this tab (driven by the chosen shellProfile). Optional for legacy tabs. */
  pathContext?: PathContext;
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
  paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown' | 'kanban' | 'artifacts' | 'pdf';
  filePath?: string;
  isDirty?: boolean;
  serializedContent?: string;
  /** One-shot startup command for this pane (e.g. resuming a session). Runs on first PTY create. */
  cmd?: string;
  label?: string;
  labelIsCustom?: boolean;
  /** ShellProfile id used to spawn this pane's PTY. Optional for legacy persisted leaves. */
  shellProfileId?: string;
  /** Path semantics for this pane. Drives basename/displayPath rendering. */
  pathContext?: PathContext;
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

// ── Kanban worker profiles & settings ──────────────────────────────────────

/** A named worker role materialized to `<workspace>/.rune/profiles/<name>.md`. */
export type WorkerProfile = {
  name: string; // ^[a-z0-9][a-z0-9_-]*$ (rune's validName)
  role: 'worker' | 'orchestrator' | 'reviewer'; // orchestrator drives decompose/specify; reviewer drives code-review runs
  model: string; // '' → leave to rune's normal provider resolution
  skills: string[];
  instructions: string; // persona / system-prompt body
};

export type KanbanSettings = {
  dispatcher: {
    intervalMs: number;
    maxInProgress: number;
    failureLimit: number;
    claimTtlMs: number;
    autoDecompose: boolean; // when true, the dispatcher auto-flags triage tasks for decompose
    maxDecompose: number; // concurrency cap for orchestrator runs (separate from maxInProgress)
    autoAssign: boolean; // when true, the dispatcher auto-assigns unassigned ready tasks to a worker profile
    autoIntegrate: boolean; // when true, auto-merges completed feature tasks into the integration branch; spawns resolve runs on conflict
    autoReview: boolean; // when true, runs an agent code-review gate before review/auto-merge
  };
  defaults: {
    workspaceKind: WorkspaceKind;
    maxRuntimeSeconds: number | null;
  };
  /** Days a discarded artifact is retained before auto-purge. 0 disables auto-purge. */
  artifactRetentionDays: number;
  profiles: WorkerProfile[];
  notifications: KanbanNotifySettings;
};

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Matches rune's profile.validName: lowercase alnum, with - or _ allowed after the first char. */
export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

/** The single orchestrator profile's reserved name. There is exactly one orchestrator. */
export const ORCHESTRATOR_PROFILE_NAME = 'orchestrator';

/**
 * Default persona for the singleton orchestrator. Complements the runtime decompose prompt
 * (which supplies the exact tool calls); this is the planning judgment. Surfaced in Settings
 * with a "Reset to default" button, so it lives here where both main (seed) and renderer can
 * reach it. Distilled from Anthropic's orchestrator-worker guidance: scale decomposition to
 * the task's real size, write self-contained children with acceptance criteria, maximize
 * parallelism, and never implement the work yourself.
 */
export const DEFAULT_ORCHESTRATOR_INSTRUCTIONS =
  'You are the Fleet kanban orchestrator. You are handed one task and must break it into a ' +
  'graph of smaller child tasks for worker agents to run. You never implement the work ' +
  'yourself — you only plan and create tasks.\n\n' +
  'Plan the whole breakdown before creating anything. Scale the number of children to the ' +
  "task's real size: prefer few, and split only until each child is a single unit a worker " +
  'can finish in one focused session. Do not over-split, and do not create a task for trivial work.\n\n' +
  'Each worker sees only its own task, with no knowledge of its siblings. So write every child ' +
  'to stand alone: restate the context it needs, state the scope, and end with explicit ' +
  'acceptance criteria ("Done when: …") a reviewer could check.\n\n' +
  'Maximize parallelism — only add a dependency (parents) when a child genuinely needs ' +
  "another's output. Keep responsibilities non-overlapping. Assign each child to the worker " +
  'whose description best matches the work; if none fits well, pick the closest and note the gap.';

/** The single reviewer profile's reserved name. There is exactly one reviewer. */
export const REVIEWER_PROFILE_NAME = 'reviewer';

/**
 * Default persona for the singleton code reviewer. Complements the runtime review prompt
 * (which supplies the diff + the kanban_review_verdict call). Surfaced in Settings with a
 * "Reset to default" button, so it lives here where both main (seed) and renderer reach it.
 */
export const DEFAULT_REVIEWER_INSTRUCTIONS = `You are a senior code reviewer. Judge the diff strictly against the task's stated goal and acceptance criteria. Approve only when the change is correct, focused, and complete; otherwise request changes with specific, actionable findings (file + what to fix). Do not nitpick formatting or style that automated verify commands already enforce. Do not implement the work yourself.`;

export type TerminalBackgroundFit = 'cover' | 'contain' | 'center' | 'tile';

export type SlideshowSourceKind = 'folder' | 'files';

export type TerminalBackgroundSlideshow = {
  enabled: boolean;
  /** Which source list is active. Both folderPath and filePaths are kept so
   * switching kinds doesn't discard the other's value. */
  source: SlideshowSourceKind;
  /** Folder scanned (non-recursively) for image files. */
  folderPath: string;
  /** Explicit list of image file paths. */
  filePaths: string[];
  /** Seconds each image is shown before advancing. */
  intervalSeconds: number;
  /** Random order (no repeats until all images shown) vs filename order. */
  shuffle: boolean;
  /** Crossfade duration in milliseconds. */
  transitionMs: number;
};

export type TerminalBackground = {
  /** Absolute path to the image on disk, served via the fleet-image:// protocol. */
  imagePath: string | null;
  /** Image visibility, 0–1. Lower values let the solid theme color show through (dimming). */
  opacity: number;
  /** Gaussian blur radius in pixels. */
  blur: number;
  /** Left & right edge feather, 0–0.5 as a fraction of the pane width. Fades the
   * side edges to transparent so a too-narrow image blends into the background. */
  edgeFadeX: number;
  /** Top & bottom edge feather, 0–0.5 as a fraction of the pane height. Fades the
   * top/bottom edges to transparent so a too-short image blends into the background. */
  edgeFadeY: number;
  fit: TerminalBackgroundFit;
  slideshow: TerminalBackgroundSlideshow;
};

/** Default terminal background. Lives here (not constants.ts) so the renderer can
 * import it without dragging node built-ins into the browser bundle. */
export const DEFAULT_TERMINAL_BACKGROUND: TerminalBackground = {
  imagePath: null,
  opacity: 0.15,
  blur: 0,
  edgeFadeX: 0,
  edgeFadeY: 0,
  fit: 'cover',
  slideshow: {
    enabled: false,
    source: 'folder',
    folderPath: '',
    filePaths: [],
    intervalSeconds: 60,
    shuffle: true,
    transitionMs: 1000
  }
};

export type FleetSettings = {
  general: {
    defaultShell: string;
    /** Preferred shell profile id for new tabs (e.g. 'wsl.Ubuntu-22.04'). Empty = auto-detect. */
    defaultShellProfileId: string;
    scrollbackSize: number;
    fontFamily: string;
    fontSize: number;
    theme: AppThemeSelection;
    terminalTheme: TerminalThemeId;
    accentColor: AccentColorId;
    terminalBackground: TerminalBackground;
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
  annotate: {
    retentionDays: number;
  };
  sessions: {
    /** Default + persisted agent filter for the Sessions tool. */
    preferredAgent: SessionAgentFilter;
  };
  /** Which sidebar Tools are visible. Disabled tools have no pinned tab. */
  tools: ToolVisibility;
  kanban: KanbanSettings;
};

export type FleetSettingsPatch = DeepPartial<FleetSettings>;

// ── Annotations ──────────────────────────────────────────────────────────

export type AnnotationMeta = {
  id: string;
  url: string;
  timestamp: number;
  elementCount: number;
  dirPath: string;
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

export type SpriteAnimations = Record<
  'idle' | 'processing' | 'permission' | 'complete',
  SpriteAnimation
>;

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
  | {
      type: 'tool_use';
      id: string;
      name: string;
      inputPreview: string;
      input?: Record<string, unknown>;
    }
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
