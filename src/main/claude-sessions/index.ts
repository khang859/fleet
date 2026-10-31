import { RUNTIMES } from '../../shared/session-runtimes';
import { createLogger } from '../logger';
import { resolveClaudeConfig } from '../../shared/claude-config';
import type { FleetSettings } from '../../shared/types';
import type { PermissionSuggestion, PlanApprovalMode } from '../../shared/claude-sessions';
import type { PriceTable } from '../../shared/claude-pricing';
import type {
  ClaudeHookInstallProblem,
  ClaudeSession,
  ClaudeSessionChange,
  ClaudeSessionsSnapshot,
  ClaudeSessionUsage,
  ClaudeTrackingStatus,
  GitSummary
} from '../../shared/claude-sessions';
import { createGitRunner, probeGit, type GitRunner } from './git-probe';
import type { HookEvent } from './hook-events';
import * as hookInstaller from './hook-installer';
import { BridgeServer, type BridgeRoute } from './bridge-server';
import { HookServer, SocketHold } from './hook-server';
import { PermissionBridge } from './permission-bridge';
import { PermissionBroker, type HeldRequest } from './permission-broker';
import { PromptInput, type SendResult } from './input';
import { PromptBridge } from './prompt-bridge';
import { registerClaudeSessionsIpc, type IpcRegistrar } from './ipc-handlers';
import { PaneActivityBridge, type SetHookState } from './pane-activity-bridge';
import { PaneResolver, type PaneHost, type WorkspaceLookup } from './pane-resolver';
import { ClaudeSessionRegistry } from './registry';
import { SessionTranscripts } from './session-transcripts';
import { SessionUsageTracker } from './session-usage';
import { sessionFilePath } from './transcript-path';

const log = createLogger('claude-sessions');

/** How often sessions whose Claude process died silently are swept. */
const LIVENESS_INTERVAL_MS = 10_000;
/** Changes landing this close together go to the renderer as one snapshot. */
const SNAPSHOT_COALESCE_MS = 100;
/** How often one session's folder is asked about its git state at most. */
const GIT_THROTTLE_MS = 5_000;
/** Hook events after which a session's folder may look different to git. */
const GIT_EVENTS = new Set(['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'Stop']);

export type ClaudeSessionsDeps = {
  platform: NodeJS.Platform;
  homeDir: string;
  getSettings: () => FleetSettings;
  panes: PaneHost;
  workspaceOf: WorkspaceLookup;
  setHookState: SetHookState;
  /** Types into a pane's terminal, as the user's keyboard would. */
  writeToPane: (paneId: string, data: string) => void;
  ipc: IpcRegistrar;
  /** The price table cost estimates use; it can change while Fleet runs. */
  priceTable: () => PriceTable;
  /** Receives the whole status view each time it changes, coalesced. */
  onSnapshot?: (snapshot: ClaudeSessionsSnapshot) => void;
  socketPath?: string;
  bridgeSocketPath?: string;
  installer?: Pick<typeof hookInstaller, 'ensureHooks' | 'uninstall'>;
  /** Adds and removes Fleet's Pi extension along with the Claude hooks. */
  piExtension?: { ensure: () => void; remove: () => void };
  /** More routes on the bridge socket, such as the workflow tools. */
  bridgeRoutes?: Record<string, BridgeRoute>;
  git?: GitRunner;
};

type GitState = {
  summary: GitSummary | null;
  checkedAt: number;
  checking: boolean;
  /** A check that was asked for inside the throttle window, due when it ends. */
  again: ReturnType<typeof setTimeout> | null;
};

/** Every Claude config folder Fleet hands to its panes: the default and each workspace's own. */
export function claudeConfigDirs(settings: FleetSettings, homeDir: string): string[] {
  const { claudeConfigDir, workspaceOverrides } = settings.copilot;
  const dirs = [resolveClaudeConfig({ defaultDir: claudeConfigDir, homeDir }).path];
  for (const override of Object.values(workspaceOverrides)) {
    const dir = override?.claudeConfigDir?.trim();
    if (dir) dirs.push(dir);
  }
  return [...new Set(dirs)];
}

/**
 * The composition root for Claude session tracking: installs the hooks, runs
 * the hook socket, and keeps the registry and the pane badges current.
 *
 * Tracking runs on macOS and Linux whenever `claudeSessions.trackSessions` is
 * on, independent of the copilot. Starting, stopping and settings changes are
 * queued, so a quick toggle never interleaves two of them.
 */
export class ClaudeSessionsService {
  readonly registry = new ClaudeSessionRegistry();
  readonly broker: PermissionBroker;
  private readonly input: PromptInput;
  private readonly server: HookServer;
  private readonly promptBridge = new PromptBridge();
  private readonly permissionBridge = new PermissionBridge((event, request) =>
    this.onHookEvent(event, () => request)
  );
  private readonly bridgeServer: BridgeServer;
  private readonly resolver: PaneResolver;
  private readonly bridge: PaneActivityBridge;
  private readonly installer: Pick<typeof hookInstaller, 'ensureHooks' | 'uninstall'>;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The setting as last applied, so turning it off can be told from starting with it off. */
  private tracking: boolean | null = null;
  private work: Promise<void> = Promise.resolve();
  /** The consumers that may answer a permission request. */
  private readonly answerers = new Set<object>();
  private readonly usage: SessionUsageTracker;
  private readonly transcripts: SessionTranscripts;
  private readonly git: GitRunner;
  private readonly gitStates = new Map<string, GitState>();
  private installProblems: ClaudeHookInstallProblem[] = [];
  private startError: string | null = null;
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ClaudeSessionsDeps) {
    this.installer = deps.installer ?? hookInstaller;
    this.git = deps.git ?? createGitRunner();
    this.usage = new SessionUsageTracker({
      priceTable: deps.priceTable,
      onChange: () => this.scheduleSnapshot()
    });
    this.transcripts = new SessionTranscripts({
      onSignal: (sessionId, signal) => this.registry.settle(sessionId, signal)
    });
    this.bridgeServer = new BridgeServer(
      {
        'GET /prompt': this.promptBridge,
        'POST /permission': this.permissionBridge,
        ...deps.bridgeRoutes
      },
      deps.bridgeSocketPath
    );
    this.input = new PromptInput({
      session: (sessionId) => this.registry.get(sessionId),
      subscribe: (listener) => this.registry.subscribe(listener),
      write: deps.writeToPane,
      bridge: this.promptBridge
    });
    this.resolver = new PaneResolver(deps.panes, deps.workspaceOf);
    this.bridge = new PaneActivityBridge(deps.setHookState);
    this.broker = new PermissionBroker((sessionId, toolUseId) => {
      this.registry.resolvePermission(sessionId, toolUseId);
    });
    this.server = new HookServer(
      (event, client) =>
        // The mod asked about it first, then passed it on to the settings hooks.
        event.event === 'PermissionRequest' && this.permissionBridge.asked(event)
          ? false
          : this.onHookEvent(event, () => new SocketHold(client)),
      deps.socketPath
    );

    this.registry.subscribe((change) => {
      // The badge follows the pane's own session, not a nested run inside it.
      const { session } = change;
      const ownsPane =
        !session ||
        session.phase === 'ended' ||
        this.registry.getByPane(session.paneId)?.sessionId === session.sessionId;
      if (ownsPane) this.bridge.apply(change);
      const pending = change.session?.pendingPermissions ?? [];
      this.broker.retainOnly(change.sessionId, new Set(pending.map((p) => p.toolUseId)));
      this.followSession(change);
    });
    registerClaudeSessionsIpc(deps.ipc, () => this.snapshot());
  }

  /** Whether tracking can run on this platform at all. */
  get supported(): boolean {
    return this.deps.platform !== 'win32';
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Whether an agent can reach Fleet's tools now. */
  get bridgeReady(): boolean {
    return this.bridgeServer.isListening;
  }

  get status(): ClaudeTrackingStatus {
    if (!this.supported) return { state: 'unsupported' };
    if (this.tracking === false) return { state: 'off' };
    if (this.startError) return { state: 'failed', detail: this.startError };
    return { state: this.running ? 'running' : 'starting' };
  }

  /** The status view: tracking status, install problems, and each pane's session. */
  snapshot(): ClaudeSessionsSnapshot {
    const sessions = this.registry
      .list()
      .filter((s) => this.registry.getByPane(s.paneId)?.sessionId === s.sessionId)
      .map((s) => ({
        ...s,
        usage: this.usageOf(s),
        git: this.gitStates.get(s.sessionId)?.summary ?? null
      }));
    return { status: this.status, installProblems: this.installProblems, sessions };
  }

  /** A session's usage, with the context window it reports itself, if it does. */
  private usageOf(session: ClaudeSession): ClaudeSessionUsage {
    const usage = this.usage.get(session.sessionId);
    return session.contextWindow ? { ...usage, contextLimit: session.contextWindow } : usage;
  }

  async start(): Promise<void> {
    return this.enqueue(async () => this.apply());
  }

  /** Re-read the settings: tracking toggled, or the set of config folders changed. */
  async onSettingsChanged(): Promise<void> {
    return this.enqueue(async () => this.apply());
  }

  onPaneClosed(paneId: string): void {
    this.registry.releasePane(paneId);
    this.resolver.forgetPane(paneId);
    this.input.forgetPane(paneId);
  }

  /** What the user types into any pane, so a prompt is never typed over theirs. */
  onPaneInput(paneId: string, data: string): void {
    this.input.onUserInput(paneId, data);
  }

  /**
   * Pick an option in the question dialog a session is showing, by its number,
   * as a key press. Refused unless a question dialog is open.
   */
  answerQuestion(sessionId: string, option: string): boolean {
    const session = this.registry.get(sessionId);
    if (session?.phase !== 'waitingForInput' || session.waitingKind !== 'question') return false;
    if (RUNTIMES[session.runtime].questionAnswers !== 'number') return false;
    if (!/^\d+$/.test(option)) return false;
    this.deps.writeToPane(session.paneId, `${option}\r`);
    return true;
  }

  /** Type a prompt into a session and submit it, or refuse without writing; see `PromptInput`. */
  async sendPrompt(sessionId: string, text: string): Promise<SendResult> {
    return this.input.send(sessionId, text);
  }

  /**
   * Declare that a consumer can answer permission requests, until the returned
   * function is called. With none left, every held hook is released at once so
   * the runtime shows its own prompt: holding one nobody can answer would stall
   * a background subagent, whose dialog waits for the hook.
   */
  addPermissionAnswerer(): () => void {
    // Its own object, so one consumer registering twice counts twice.
    const answerer = {};
    this.answerers.add(answerer);
    return () => {
      if (this.answerers.delete(answerer) && this.answerers.size === 0) this.releaseHeld();
    };
  }

  /**
   * Answer a held request. A deny's `reason` is what the model reads, such as
   * what to change in a plan. An allow can take one change along with it:
   * `suggestion` picks one Claude Code suggested, by its place in the
   * request's `suggestions`, and `mode` the mode an `ExitPlanMode` plan is
   * approved into, for this session only. Refused for a deny, a suggestion
   * the request does not have, a mode for any other tool, or both.
   */
  respondToPermission(
    toolUseId: string,
    decision: 'allow' | 'deny',
    reason?: string,
    suggestion?: number,
    mode?: PlanApprovalMode
  ): boolean {
    if (suggestion === undefined && mode === undefined) {
      return this.broker.respond(toolUseId, decision, reason);
    }
    if (decision !== 'allow') return false;
    const change = this.changeToAllow(toolUseId, suggestion, mode);
    return change !== undefined && this.broker.respond(toolUseId, decision, reason, [change]);
  }

  /** The change an allow applies along with a held request, as `respondToPermission` picks it. */
  private changeToAllow(
    toolUseId: string,
    suggestion?: number,
    mode?: PlanApprovalMode
  ): PermissionSuggestion | undefined {
    const pending = this.registry
      .list()
      .flatMap((s) => s.pendingPermissions)
      .find((p) => p.toolUseId === toolUseId);
    if (mode === undefined) {
      return suggestion === undefined ? undefined : pending?.suggestions?.[suggestion];
    }
    if (suggestion !== undefined || pending?.tool.toolName !== 'ExitPlanMode') return undefined;
    return { type: 'setMode', mode, destination: 'session' };
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      await this.halt();
      if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    });
  }

  private async enqueue(task: () => Promise<void>): Promise<void> {
    this.work = this.work.then(task).catch((err: unknown) => {
      log.error('claude sessions task failed', { error: String(err) });
    });
    return this.work;
  }

  private async apply(): Promise<void> {
    const settings = this.deps.getSettings();
    const wanted = settings.claudeSessions.trackSessions;
    const dirs = claudeConfigDirs(settings, this.deps.homeDir);
    const turnedOff = this.tracking === true && !wanted;
    this.tracking = wanted;

    if (!this.supported) return this.startWindowsBridge();

    if (!wanted) {
      this.installProblems = [];
      this.startError = null;
      this.scheduleSnapshot();
      await this.halt();
      if (turnedOff) {
        for (const dir of dirs) {
          try {
            this.installer.uninstall(dir);
          } catch (err) {
            log.warn('could not remove hooks', { configDir: dir, error: String(err) });
          }
        }
        this.removePiExtension();
      }
      return;
    }

    // Every time, not only at start: it adds a newly assigned folder and
    // refreshes the binary after an upgrade. Unchanged folders are not written.
    const failures = this.installer.ensureHooks(dirs);
    this.installProblems = [...failures].map(([configDir, error]) => ({
      configDir,
      detail: error.message
    }));
    this.ensurePiExtension();
    this.scheduleSnapshot();

    if (this.running) return;
    try {
      await this.server.start();
    } catch (err) {
      this.startError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    this.startError = null;
    try {
      await this.bridgeServer.start();
    } catch (err) {
      // Prompts are typed and permissions go to the Go hook instead, as without the mod.
      log.warn('fleet-bridge socket did not start', { error: String(err) });
    }
    this.liveness = setInterval(() => this.registry.pruneDead(), LIVENESS_INTERVAL_MS);
    this.liveness.unref();
    this.running = true;
    this.scheduleSnapshot();
    log.info('claude session tracking started', { configDirs: dirs });
  }

  /** Windows has no session tracking, but a workflow's Pi agents still need the bridge. */
  private async startWindowsBridge(): Promise<void> {
    this.ensurePiExtension();
    if (this.bridgeServer.isListening) return;
    try {
      await this.bridgeServer.start();
    } catch (err) {
      log.warn('fleet-bridge pipe did not start', { error: String(err) });
    }
  }

  private ensurePiExtension(): void {
    try {
      this.deps.piExtension?.ensure();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.installProblems.push({ configDir: 'Pi', detail });
    }
  }

  private removePiExtension(): void {
    try {
      this.deps.piExtension?.remove();
    } catch (err) {
      log.warn('could not remove the Pi extension', { error: String(err) });
    }
  }

  private async halt(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.liveness) clearInterval(this.liveness);
    this.liveness = null;
    // First, so no prompt goes to a mod while the rest stops.
    await this.bridgeServer.stop();
    await this.broker.dispose();
    await this.server.stop();
    this.registry.clear();
    this.usage.dispose();
    this.transcripts.dispose();
    for (const sessionId of [...this.gitStates.keys()]) this.forgetGit(sessionId);
    this.scheduleSnapshot();
    log.info('claude session tracking stopped');
  }

  /** Keep a session's usage and git state current as its hook events arrive. */
  private followSession(change: ClaudeSessionChange): void {
    const { session, sessionId, event } = change;
    this.scheduleSnapshot();
    if (!session) {
      this.usage.forget(sessionId);
      this.transcripts.forget(sessionId);
      this.forgetGit(sessionId);
      return;
    }
    if (session.phase === 'ended') return;
    const firstSight = !this.gitStates.has(sessionId);
    if (firstSight || (event && GIT_EVENTS.has(event.event))) this.checkGit(sessionId, session.cwd);
    // eva's turns are read from its database when asked, and it has no transcript file to total.
    const transcriptPath = sessionFilePath(session, this.deps.homeDir);
    if (transcriptPath === null) return;
    // Only a hook event moves the transcript mark; a change the transcript
    // itself caused must not. Pi's extension reports its turns, so it needs no mark.
    if (event && session.runtime === 'claude') {
      this.transcripts.onHookEvent(sessionId, transcriptPath);
    }
    if (event || firstSight) {
      const turnOver = event?.event === 'Stop' || event?.event === 'SessionStart';
      this.usage.refresh(sessionId, transcriptPath, turnOver, session.runtime);
    }
  }

  /** Ask git about a session's folder, at most every few seconds, and once more after a skipped ask. */
  private checkGit(sessionId: string, cwd: string): void {
    const state = this.gitStates.get(sessionId) ?? {
      summary: null,
      checkedAt: 0,
      checking: false,
      again: null
    };
    this.gitStates.set(sessionId, state);
    if (state.checking || state.again) return;
    const wait = GIT_THROTTLE_MS - (Date.now() - state.checkedAt);
    if (wait > 0) {
      state.again = setTimeout(() => {
        state.again = null;
        if (this.gitStates.get(sessionId) === state) this.checkGit(sessionId, cwd);
      }, wait);
      state.again.unref();
      return;
    }
    state.checking = true;
    state.checkedAt = Date.now();
    void probeGit(cwd, this.git).then((summary) => {
      state.checking = false;
      if (this.gitStates.get(sessionId) !== state) return;
      if (JSON.stringify(summary) === JSON.stringify(state.summary)) return;
      state.summary = summary;
      this.scheduleSnapshot();
    });
  }

  private forgetGit(sessionId: string): void {
    const state = this.gitStates.get(sessionId);
    if (state?.again) clearTimeout(state.again);
    this.gitStates.delete(sessionId);
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer || !this.deps.onSnapshot) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      this.deps.onSnapshot?.(this.snapshot());
    }, SNAPSHOT_COALESCE_MS);
  }

  /**
   * Take in one hook event. A permission request some answerer can answer is
   * held through `open`, and true is returned; otherwise the asker gets no answer.
   */
  private onHookEvent(event: HookEvent, open: () => HeldRequest): boolean {
    const placement = this.resolver.resolve(event);
    if (!placement) {
      log.debug('hook event from outside a Fleet pane dropped', { sessionId: event.sessionId });
      return false;
    }
    const recorded = this.registry.ingest(event, placement);
    const toolUseId = recorded?.toolUseId;
    if (event.status !== 'waiting_for_approval' || !toolUseId) return false;
    const session = this.registry.get(event.sessionId);
    const request = session?.pendingPermissions.find((p) => p.toolUseId === toolUseId);
    if (!session || !request) return false;
    if (this.answerers.size === 0) return false;
    this.broker.hold(event.sessionId, toolUseId, open());
    return true;
  }

  private releaseHeld(): void {
    for (const held of this.broker.list()) this.broker.letGo(held.toolUseId);
  }
}
