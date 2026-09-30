/**
 * What Fleet knows about each Claude Code session running in one of its panes.
 *
 * Main owns the record, built from Claude Code hook events. The copilot mascot,
 * the status view and the Orchestrator all read this same shape.
 */

/**
 * - `starting`: Fleet knows of the session but it has said nothing about its turn yet.
 * - `processing`: a turn is running, including tools and subagents.
 * - `waitingForInput`: the turn is over; see `waitingKind` for what it waits on.
 * - `waitingForApproval`: a tool is blocked on a permission answer.
 * - `compacting`: Claude Code is compacting the conversation.
 * - `ended`: the session is over; it is dropped from the registry shortly after.
 */
export type ClaudeSessionPhase =
  | 'starting'
  | 'processing'
  | 'waitingForInput'
  | 'waitingForApproval'
  | 'compacting'
  | 'ended';

/**
 * What a session in `waitingForInput` is waiting for: its normal prompt, or an
 * answer to an AskUserQuestion dialog. Typing free text into the dialog would
 * answer it with garbage, so anything that sends input must check this.
 */
export type ClaudeWaitingKind = 'prompt' | 'question';

export type ClaudeToolInfo = {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId?: string;
};

export type ClaudePendingPermission = {
  sessionId: string;
  toolUseId: string;
  tool: ClaudeToolInfo;
  receivedAt: number;
};

export type ClaudeSession = {
  sessionId: string;
  /** The Fleet pane the session runs in. Sessions outside Fleet panes are never tracked. */
  paneId: string;
  /**
   * Bumped each time the pane's Claude starts a new session in place, as
   * `/clear` does. Anything keyed to an older epoch no longer describes it.
   */
  epoch: number;
  cwd: string;
  projectName: string;
  phase: ClaudeSessionPhase;
  /** Set only while `phase` is `waitingForInput`. */
  waitingKind: ClaudeWaitingKind | null;
  /** When `phase` last changed, in epoch milliseconds. */
  phaseSince: number;
  pid?: number;
  tty?: string;
  workspaceId?: string;
  workspaceName?: string;
  /** Where Claude Code writes the transcript, when the hook reported it. */
  transcriptPath: string | null;
  /** The Claude config folder the session runs with, when it is not the default. */
  configDir: string | null;
  pendingPermissions: ClaudePendingPermission[];
  lastActivity: number;
  createdAt: number;
};

/** One hook event as the registry retained it, in arrival order. */
export type ClaudeSessionEvent = {
  /** Monotonic across the registry, so "events after N" is a single comparison. */
  seq: number;
  sessionId: string;
  at: number;
  /** The Claude Code hook event name, e.g. `Stop` or `PreToolUse`. */
  event: string;
  status: string;
  /** The session's phase after this event was applied. */
  phase: ClaudeSessionPhase;
  tool?: string;
  toolUseId?: string;
  notificationType?: string;
  message?: string;
};

/**
 * Whether a Claude config folder has Fleet's hooks. `unreadable` means its
 * `settings.json` could not be parsed, so Fleet will not touch it; `detail`
 * says why.
 */
export type HookFolderStatus =
  | { state: 'installed' | 'missing' }
  | { state: 'unreadable'; detail: string };

/** Who typed a prompt into a session: the user, or the Orchestrator on their behalf. */
export type ClaudeInputOrigin = 'user' | 'orchestrator';

/**
 * A change to one session. `session` is null when it left the registry, and
 * `event` is the hook event that caused the change, if one did.
 */
export type ClaudeSessionChange = {
  sessionId: string;
  session: ClaudeSession | null;
  event: ClaudeSessionEvent | null;
};

/** What a session's folder looks like to git. */
export type GitSummary = {
  /** The branch name, or a short commit id when HEAD is detached. */
  branch: string;
  /** Changed, staged and untracked files. A lower bound when `truncated`. */
  dirtyFiles: number;
  /** Lines added and removed against HEAD, across tracked files. */
  insertions: number;
  deletions: number;
  /** Git's output hit Fleet's size cap, so the counts are incomplete. */
  truncated: boolean;
};

/** Estimates from the session's transcript. Each is null until it can be worked out. */
export type ClaudeSessionUsage = {
  /** Estimated spend so far, including subagents. Null when a model has no known price. */
  costUsd: number | null;
  /** Tokens in the main conversation's context at its latest message. */
  contextTokens: number | null;
  /** The context window `contextTokens` is measured against. */
  contextLimit: number | null;
};

/** A session as the status view and the Orchestrator see it. */
export type ClaudeSessionView = ClaudeSession & {
  usage: ClaudeSessionUsage;
  git: GitSummary | null;
};

/**
 * Whether session tracking is working. `starting` covers the moment before
 * the hook socket is up; `failed` means it could not start at all.
 */
export type ClaudeTrackingStatus =
  | { state: 'starting' | 'running' | 'off' | 'unsupported' }
  | { state: 'failed'; detail: string };

/** A Claude config folder Fleet could not install its hooks into, and why. */
export type ClaudeHookInstallProblem = { configDir: string; detail: string };

/** Everything the status view shows, sent whole on each change. */
export type ClaudeSessionsSnapshot = {
  status: ClaudeTrackingStatus;
  installProblems: ClaudeHookInstallProblem[];
  /** One per pane: a session run by a tool inside a pane is left out. */
  sessions: ClaudeSessionView[];
};
