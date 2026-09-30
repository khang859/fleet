import type { Socket } from 'net';
import { createLogger } from '../logger';
import { resolveClaudeConfig } from '../../shared/claude-config';
import type { FleetSettings } from '../../shared/types';
import type { ClaudeInputOrigin } from '../../shared/claude-sessions';
import type { PriceTable } from '../../shared/claude-pricing';
import type {
  ClaudeHookInstallProblem,
  ClaudeSessionChange,
  ClaudeSessionsSnapshot,
  ClaudeTrackingStatus,
  GitSummary
} from '../../shared/claude-sessions';
import { createGitRunner, probeGit, type GitRunner } from './git-probe';
import type { HookEvent } from './hook-events';
import * as hookInstaller from './hook-installer';
import { HookServer, PermissionBroker } from './hook-server';
import { PromptInput, type SendResult } from './input';
import { registerClaudeSessionsIpc, type IpcRegistrar } from './ipc-handlers';
import { PaneActivityBridge, type SetHookState } from './pane-activity-bridge';
import { PaneResolver, type PaneHost, type WorkspaceLookup } from './pane-resolver';
import { ClaudeSessionRegistry, type NotedInput } from './registry';
import { SessionTranscripts, type SessionTranscript } from './session-transcripts';
import { SessionUsageTracker } from './session-usage';
import { transcriptPathFor } from './transcript-path';

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
  installer?: Pick<typeof hookInstaller, 'ensureHooks' | 'uninstall'>;
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
  private readonly resolver: PaneResolver;
  private readonly bridge: PaneActivityBridge;
  private readonly installer: Pick<typeof hookInstaller, 'ensureHooks' | 'uninstall'>;
  private liveness: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The setting as last applied, so turning it off can be told from starting with it off. */
  private tracking: boolean | null = null;
  private work: Promise<void> = Promise.resolve();
  /** How many consumers can answer a permission request right now. */
  private answerers = 0;
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
    this.input = new PromptInput({
      session: (sessionId) => this.registry.get(sessionId),
      noteInput: (sessionId, origin, text) => this.registry.noteInput(sessionId, origin, text),
      subscribe: (listener) => this.registry.subscribe(listener),
      write: deps.writeToPane
    });
    this.resolver = new PaneResolver(deps.panes, deps.workspaceOf);
    this.bridge = new PaneActivityBridge(deps.setHookState);
    this.broker = new PermissionBroker((sessionId, toolUseId) =>
      this.registry.resolvePermission(sessionId, toolUseId)
    );
    this.server = new HookServer(
      (event, client) => this.onHookEvent(event, client),
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
        usage: this.usage.get(s.sessionId),
        git: this.gitStates.get(s.sessionId)?.summary ?? null
      }));
    return { status: this.status, installProblems: this.installProblems, sessions };
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
    if (!/^\d+$/.test(option)) return false;
    this.deps.writeToPane(session.paneId, `${option}\r`);
    return true;
  }

  /** Type a prompt into a session and submit it, or refuse without writing; see `PromptInput`. */
  async sendPrompt(
    sessionId: string,
    text: string,
    origin: ClaudeInputOrigin
  ): Promise<SendResult> {
    return this.input.send(sessionId, text, origin);
  }

  /** Why `sendPrompt` would refuse this session right now, or `null`. */
  sendRefusal(sessionId: string): string | null {
    return this.input.refusal(sessionId);
  }

  /**
   * Declare that a consumer can answer permission requests, until the returned
   * function is called. With none, permission hooks are released at once so
   * Claude Code shows its own prompt: holding one nobody can answer would stall
   * a background subagent, whose dialog waits for the hook.
   */
  addPermissionAnswerer(): () => void {
    this.answerers++;
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.answerers--;
      if (this.answerers === 0) void this.broker.dispose();
    };
  }

  /** A live session's transcript, read up to now, with its brief. */
  async transcript(sessionId: string): Promise<SessionTranscript | null> {
    return this.transcripts.read(sessionId);
  }

  /** Prompts typed into a session through Fleet, newest last, with who typed them. */
  inputsFor(sessionId: string): NotedInput[] {
    return this.registry.inputsFor(sessionId);
  }

  respondToPermission(toolUseId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    return this.broker.respond(toolUseId, decision, reason);
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

    if (!this.supported) return;

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
    this.scheduleSnapshot();

    if (this.running) return;
    try {
      await this.server.start();
    } catch (err) {
      this.startError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    this.startError = null;
    this.liveness = setInterval(() => this.registry.pruneDead(), LIVENESS_INTERVAL_MS);
    this.liveness.unref();
    this.running = true;
    this.scheduleSnapshot();
    log.info('claude session tracking started', { configDirs: dirs });
  }

  private async halt(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.liveness) clearInterval(this.liveness);
    this.liveness = null;
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
    const transcriptPath = transcriptPathFor(session, this.deps.homeDir);
    // Only a hook event moves the transcript mark; a change the transcript
    // itself caused must not.
    if (event) this.transcripts.onHookEvent(sessionId, transcriptPath);
    if (event || firstSight) {
      const turnOver = event?.event === 'Stop' || event?.event === 'SessionStart';
      this.usage.refresh(sessionId, transcriptPath, turnOver);
    }
    if (firstSight || (event && GIT_EVENTS.has(event.event))) this.checkGit(sessionId, session.cwd);
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

  private onHookEvent(event: HookEvent, client: Socket): boolean {
    const placement = this.resolver.resolve(event);
    if (!placement) {
      log.debug('hook event from outside a Fleet pane dropped', { sessionId: event.sessionId });
      return false;
    }
    const recorded = this.registry.ingest(event, placement);
    const toolUseId = recorded?.toolUseId;
    if (event.status !== 'waiting_for_approval' || !toolUseId || this.answerers === 0) return false;
    const pending = this.registry.get(event.sessionId)?.pendingPermissions ?? [];
    if (!pending.some((p) => p.toolUseId === toolUseId)) return false;
    this.broker.hold(event.sessionId, toolUseId, client);
    return true;
  }
}
