import type { PathContext } from './shell-profiles';
import type { AccentColorId, AppThemeSelection, TerminalThemeId } from './theme-presets';
import type { ToolVisibility } from './tools';
import type { UserGroupColor } from './group-colors';
import type { AiSettings } from './agent-types';
import type { RemoteHost } from './remote-ssh-types';

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<infer U>
    ? U[]
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
  userGroups?: UserGroup[];
};

export type UserGroup = {
  id: string;
  name: string;
  color: UserGroupColor;
  collapsed: boolean;
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
    | 'settings'
    | 'annotate'
    | 'markdown'
    | 'artifacts'
    | 'pdf'
    | 'sessions'
    | 'agent'
    | 'ssh-browser';
  avatarVariant?: string;
  splitRoot: PaneNode;
  // Worktree group fields
  groupId?: string;
  groupRole?: 'parent' | 'worktree';
  groupLabel?: string;
  worktreeBranch?: string;
  worktreePath?: string;
  userGroupId?: string;
  /**
   * The terminal session this file tab was opened from. Purely a sidebar
   * nesting relation - the tab is otherwise independent, and a parent that is
   * gone (session closed) simply renders the file at the top level again.
   */
  parentTabId?: string;
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
  paneType?:
    | 'terminal'
    | 'file'
    | 'image'
    | 'markdown'
    | 'artifacts'
    | 'pdf'
    | 'agent'
    | 'ssh-browser';
  filePath?: string;
  /**
   * The SSH target this pane's content lives on. Deliberately orthogonal to
   * `pathContext`: that field answers "how do I reach this path with local fs /
   * local process spawning", which a remote path never satisfies. When set, the
   * pane reads through `window.fleet.remoteSsh` instead of `window.fleet.file`.
   */
  remoteHost?: RemoteHost;
  /** Current directory for an `ssh-browser` pane. */
  remotePath?: string;
  /**
   * Which session file an `agent` pane's thread is written to and read back
   * from. Minted when the pane opens and persisted with the layout, so the pane
   * finds its own conversation again after a restart.
   */
  agentSessionId?: string;
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
  /**
   * The image mode was showing before the user switched to None, so switching
   * back restores it instead of asking them to browse again.
   *
   * Persisted rather than held in the settings pane because the copy behind it
   * is swept the moment nothing points at it: a path only React knew about
   * would have its file collected out from under it, and the restore would put
   * back a background that no longer exists.
   */
  stashedImagePath: string | null;
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
  /** How much of its own theme colour a terminal or agent pane keeps once it is
   * sitting over the image, 0–100. Higher is more solid and more legible; lower
   * lets more of the picture through. */
  paneTint: number;
  /** Backdrop blur behind a pane, in pixels. Unlike `blur`, which softens the
   * image everywhere, this frosts only what shows through a pane - the gutter
   * between panes stays sharp, which is what makes them read as sheets of
   * glass. 0 disables the filter entirely. */
  paneFrost: number;
  /** Saturation multiplier applied to what shows through a pane. Dimming an
   * image with `opacity` drains its colour along with its brightness; this
   * puts the colour back without making the picture any brighter. 1 = off. */
  paneSaturation: number;
};

/** Default terminal background. Lives here (not constants.ts) so the renderer can
 * import it without dragging node built-ins into the browser bundle. */
export const DEFAULT_TERMINAL_BACKGROUND: TerminalBackground = {
  imagePath: null,
  stashedImagePath: null,
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
  },
  // The values the panes were hardcoded to before these were settings, so an
  // upgrade changes nothing until the user moves a slider.
  paneTint: 22,
  paneFrost: 0,
  paneSaturation: 1
};

/**
 * Lines of scrollback each terminal retains. Kept deliberately low: xterm holds
 * the buffer in the JS heap at roughly 3.2 KB per retained line, and Fleet's
 * whole point is running many panes at once. VS Code, the closest precedent
 * (same engine, many concurrent terminals), still ships 1,000.
 *
 * Lives here rather than in `constants.ts` because that module imports Node
 * built-ins and so cannot be pulled into the renderer.
 */
export const DEFAULT_SCROLLBACK = 3000;

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
  /** Which sidebar Tools are visible. Disabled tools have no pinned tab. */
  tools: ToolVisibility;
  ai: AiSettings;
  remoteSsh: {
    /** Saved SSH targets. Connection coordinates only - never key material. */
    hosts: RemoteHost[];
  };
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
  /** Keyed by workspace id: only workspaces with an override appear, so a lookup can miss. */
  workspaceOverrides: Record<string, CopilotWorkspaceOverride | undefined>;
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
