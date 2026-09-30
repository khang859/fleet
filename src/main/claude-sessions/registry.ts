import { createHash } from 'crypto';
import { createLogger } from '../logger';
import { isProcessAlive } from '../process-liveness';
import type {
  ClaudeInputOrigin,
  ClaudeSession,
  ClaudeSessionChange,
  ClaudeSessionEvent
} from '../../shared/claude-sessions';
import type { HookEvent } from './hook-events';
import {
  INITIAL_PHASE,
  nextPaneEpoch,
  reducePhase,
  resolvePermission,
  TOOL_FINISHED,
  TURN_BOUNDARIES,
  type PaneEpoch
} from './phase';

const log = createLogger('claude-sessions:registry');

/** Time, injectable so tests can drive it. */
export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
};

/** Where an event's session runs, as the pane resolver found it. */
export type PanePlacement = {
  paneId: string;
  workspaceId?: string;
  workspaceName?: string;
};

/** A prompt Fleet typed into a session, kept so reads can tell who wrote it. */
export type NotedInput = {
  origin: ClaudeInputOrigin;
  /** sha256 of the prompt text, so the text itself is not kept twice. */
  hash: string;
  at: number;
};

export type RegistryOptions = {
  clock?: Clock;
  isAlive?: (pid: number) => boolean;
  /** How many events each session keeps. */
  eventLimit?: number;
  /** How long an ended session stays visible before it is dropped. */
  endedRetentionMs?: number;
};

const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_ENDED_RETENTION_MS = 30_000;
const NOTED_INPUT_LIMIT = 50;
/** `SessionStart` sources that mean the pane's Claude switched conversations. */
const IN_PLACE_SOURCES = new Set(['clear', 'resume']);

export function hashPrompt(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function projectNameFromCwd(cwd: string): string {
  const parts = cwd.split(/[/\\]/);
  return parts[parts.length - 1] || cwd;
}

type Entry = {
  session: ClaudeSession;
  events: ClaudeSessionEvent[];
  inputs: NotedInput[];
  /** Tool use ids from `PreToolUse`, for permission requests that arrive without one. */
  toolUseIds: Map<string, string[]>;
  removal: ReturnType<typeof setTimeout> | null;
};

/**
 * The single record of Claude Code sessions running in Fleet panes.
 *
 * Fed by hook events that already carry a verified pane. Sessions are
 * snapshots: every change replaces the object, so a consumer can hold one
 * without it moving underneath it.
 */
export class ClaudeSessionRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly paneEpochs = new Map<string, PaneEpoch>();
  private readonly listeners = new Set<(change: ClaudeSessionChange) => void>();
  private readonly clock: Clock;
  private readonly isAlive: (pid: number) => boolean;
  private readonly eventLimit: number;
  private readonly endedRetentionMs: number;
  private seq = 0;

  constructor(options: RegistryOptions = {}) {
    this.clock = options.clock ?? realClock;
    this.isAlive = options.isAlive ?? isProcessAlive;
    this.eventLimit = options.eventLimit ?? DEFAULT_EVENT_LIMIT;
    this.endedRetentionMs = options.endedRetentionMs ?? DEFAULT_ENDED_RETENTION_MS;
  }

  /** Live sessions, oldest first. Ended sessions are left out. */
  list(): ClaudeSession[] {
    const sessions: ClaudeSession[] = [];
    for (const entry of this.entries.values()) {
      if (entry.session.phase !== 'ended') sessions.push(entry.session);
    }
    return sessions;
  }

  /** A session by id, including one that has ended but not yet been dropped. */
  get(sessionId: string): ClaudeSession | undefined {
    return this.entries.get(sessionId)?.session;
  }

  /** The live session running in a pane, if any. */
  getByPane(paneId: string): ClaudeSession | undefined {
    const current = this.paneEpochs.get(paneId);
    if (!current) return undefined;
    const session = this.entries.get(current.sessionId)?.session;
    return session?.paneId === paneId && session.phase !== 'ended' ? session : undefined;
  }

  /** A session's retained events with a sequence number above `seq`, oldest first. */
  eventsAfter(sessionId: string, seq: number): ClaudeSessionEvent[] {
    return this.entries.get(sessionId)?.events.filter((e) => e.seq > seq) ?? [];
  }

  /** The highest sequence number handed out so far. */
  lastSeq(): number {
    return this.seq;
  }

  subscribe(listener: (change: ClaudeSessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply a hook event from a session in `placement`'s pane. Returns the event
   * as recorded, or null when it was ignored (a late event from an ended session).
   */
  ingest(event: HookEvent, placement: PanePlacement): ClaudeSessionEvent | null {
    const now = this.clock.now();
    let entry = this.entries.get(event.sessionId);

    // An ended session hears nothing more, unless Claude resumes it.
    if (entry?.session.phase === 'ended' && event.event !== 'SessionStart') return null;

    const current = this.paneEpochs.get(placement.paneId);
    let epoch: number;
    if (!current || this.takesOverPane(current, event)) {
      const next = nextPaneEpoch(current, event.sessionId);
      this.paneEpochs.set(placement.paneId, { sessionId: next.sessionId, epoch: next.epoch });
      if (next.replaces) this.end(next.replaces, 'replaced in its pane');
      epoch = next.epoch;
    } else {
      // A second Claude in the same pane, such as `claude -p` run by a tool:
      // tracked, but the pane stays with the session it had.
      epoch = current.epoch;
    }

    if (!entry) {
      entry = {
        session: {
          sessionId: event.sessionId,
          paneId: placement.paneId,
          epoch,
          cwd: event.cwd,
          projectName: projectNameFromCwd(event.cwd),
          ...INITIAL_PHASE,
          phaseSince: now,
          transcriptPath: null,
          configDir: null,
          lastActivity: now,
          createdAt: now
        },
        events: [],
        inputs: [],
        toolUseIds: new Map(),
        removal: null
      };
      this.entries.set(event.sessionId, entry);
      log.info('session tracked', { sessionId: event.sessionId, paneId: placement.paneId });
    }
    if (entry.removal) {
      this.clock.clearTimeout(entry.removal);
      entry.removal = null;
    }

    const toolUseId = this.toolUseIdFor(entry, event, now);
    const before = entry.session;
    const next = reducePhase(before, {
      sessionId: event.sessionId,
      event: event.event,
      status: event.status,
      tool: event.tool,
      toolInput: event.toolInput,
      toolUseId,
      notificationType: event.notificationType,
      at: now
    });

    const session: ClaudeSession = {
      ...before,
      ...next,
      paneId: placement.paneId,
      epoch,
      phaseSince: next.phase === before.phase ? before.phaseSince : now,
      pid: event.pid ?? before.pid,
      tty: event.tty ?? before.tty,
      workspaceId: placement.workspaceId ?? before.workspaceId,
      workspaceName: placement.workspaceName ?? before.workspaceName,
      transcriptPath: event.transcriptPath ?? before.transcriptPath,
      configDir: event.configDir ?? before.configDir,
      lastActivity: now
    };

    const recorded: ClaudeSessionEvent = {
      seq: ++this.seq,
      sessionId: event.sessionId,
      at: now,
      event: event.event,
      status: event.status,
      phase: session.phase,
      tool: event.tool,
      toolUseId,
      notificationType: event.notificationType,
      message: event.message
    };
    entry.events.push(recorded);
    if (entry.events.length > this.eventLimit) entry.events.shift();

    this.commit(entry, session, recorded);
    return recorded;
  }

  /**
   * Whether an event's session becomes the one its pane runs. A new session
   * id from the same Claude process is a fresh conversation in place, as
   * `/clear` and `/resume` make; one from another process is a nested run
   * unless the pane's session is gone.
   */
  private takesOverPane(current: PaneEpoch, event: HookEvent): boolean {
    if (current.sessionId === event.sessionId) return true;
    const holder = this.entries.get(current.sessionId)?.session;
    if (!holder || holder.phase === 'ended') return true;
    if (event.pid !== undefined && holder.pid !== undefined) {
      return event.pid === holder.pid || !this.isAlive(holder.pid);
    }
    return event.event === 'SessionStart' && IN_PLACE_SOURCES.has(event.source ?? '');
  }

  /** A permission was answered outside the event stream. */
  resolvePermission(sessionId: string, toolUseId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    const next = resolvePermission(entry.session, toolUseId);
    if (next === entry.session) return;
    const phaseSince =
      next.phase === entry.session.phase ? entry.session.phaseSince : this.clock.now();
    this.commit(entry, { ...entry.session, ...next, phaseSince }, null);
  }

  /** Record a prompt Fleet typed into a session. */
  noteInput(sessionId: string, origin: ClaudeInputOrigin, text: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.inputs.push({ origin, hash: hashPrompt(text), at: this.clock.now() });
    if (entry.inputs.length > NOTED_INPUT_LIMIT) entry.inputs.shift();
  }

  /** Prompts Fleet typed into a session, oldest first. */
  inputsFor(sessionId: string): NotedInput[] {
    return [...(this.entries.get(sessionId)?.inputs ?? [])];
  }

  /** End sessions whose Claude process has exited without saying so. */
  pruneDead(): void {
    for (const entry of this.entries.values()) {
      const { session } = entry;
      if (session.phase === 'ended' || session.pid === undefined) continue;
      if (!this.isAlive(session.pid)) this.end(session.sessionId, 'process exited');
    }
  }

  /** A pane closed: whatever ran in it is over. */
  releasePane(paneId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.session.paneId === paneId) this.end(entry.session.sessionId, 'pane closed');
    }
    this.paneEpochs.delete(paneId);
  }

  /** Forget every session, telling subscribers each one left. */
  clear(): void {
    for (const [sessionId, entry] of [...this.entries]) {
      if (entry.removal) this.clock.clearTimeout(entry.removal);
      this.entries.delete(sessionId);
      this.emit({ sessionId, session: null, event: null });
    }
    this.paneEpochs.clear();
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.removal) this.clock.clearTimeout(entry.removal);
    }
    this.entries.clear();
    this.paneEpochs.clear();
    this.listeners.clear();
  }

  private end(sessionId: string, reason: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.session.phase === 'ended') return;
    log.info('session ended', { sessionId, reason });
    const now = this.clock.now();
    this.commit(
      entry,
      {
        ...entry.session,
        phase: 'ended',
        waitingKind: null,
        pendingPermissions: [],
        phaseSince: now
      },
      null
    );
  }

  private commit(entry: Entry, session: ClaudeSession, event: ClaudeSessionEvent | null): void {
    entry.session = session;
    if (session.phase === 'ended') {
      entry.toolUseIds.clear();
      entry.removal ??= this.clock.setTimeout(
        () => this.remove(session.sessionId),
        this.endedRetentionMs
      );
    }
    this.emit({ sessionId: session.sessionId, session, event });
  }

  private remove(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.emit({ sessionId, session: null, event: null });
  }

  private emit(change: ClaudeSessionChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        log.error('session listener failed', { error: String(err) });
      }
    }
  }

  /**
   * The tool use id for an event. Permission requests can arrive without one,
   * so ids seen on `PreToolUse` are queued by tool and input and handed out in
   * order.
   */
  private toolUseIdFor(entry: Entry, event: HookEvent, now: number): string | undefined {
    // A tool that was denied or interrupted never finishes; its id must not
    // outlive the turn and be handed to a later, identical call.
    if (TURN_BOUNDARIES.has(event.event)) entry.toolUseIds.clear();
    if (!event.tool) return event.toolUseId;
    const key = `${event.tool}:${JSON.stringify(event.toolInput ?? {})}`;
    if (event.event === 'PreToolUse' && event.toolUseId) {
      const queue = entry.toolUseIds.get(key) ?? [];
      queue.push(event.toolUseId);
      entry.toolUseIds.set(key, queue);
      return event.toolUseId;
    }
    if (event.status === 'waiting_for_approval' && !event.toolUseId) {
      // Every permission needs an id to be answered by; one Claude never named
      // gets a local one.
      return entry.toolUseIds.get(key)?.shift() ?? `unknown-${now}`;
    }
    if (TOOL_FINISHED.has(event.event) && event.toolUseId) {
      const queue = entry.toolUseIds.get(key);
      const at = queue?.indexOf(event.toolUseId) ?? -1;
      if (queue && at >= 0) queue.splice(at, 1);
    }
    return event.toolUseId;
  }
}
