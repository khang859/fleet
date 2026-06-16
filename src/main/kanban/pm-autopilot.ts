import type { TaskEvent, PmTurnOrigin } from '../../shared/kanban-types';

/** Event kinds that warrant a PM event-turn (the actual appendEvent kind strings). */
const TRIGGER_KINDS = new Set([
  'completed',
  'blocked',
  'review_ready',
  'verify_failed',
  'gave_up',
  'feature_pr_ready'
]);

export interface PmAutopilotConfig {
  autopilotEnabled: boolean;
  eventMinGapMs: number;
  coalesceWindowMs: number;
}

export interface PmAutopilotDeps {
  now: () => number;
  getConfig: () => PmAutopilotConfig;
  /** Resolve the board a task belongs to, or null if it no longer exists. */
  getBoardForTask: (taskId: string) => string | null;
  /** Run a serialized PM turn (delegates to PmChatService.runTurn). */
  runTurn: (boardId: string, prompt: string, origin: PmTurnOrigin) => Promise<void>;
  /** Build the turn prompt from a coalesced batch of events. */
  buildBriefing: (events: TaskEvent[]) => string;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

interface BoardBatch {
  events: TaskEvent[];
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  /** When the next event turn is allowed to fire (min-gap watermark). */
  nextAllowedAt: number;
  gapTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Second consumer of KanbanStore.onEvent. Decides WHEN the PM takes an
 * event-driven turn: filters noise, coalesces bursts, enforces a per-board
 * min-gap, and delegates the actual turn to a single-flight runTurn.
 */
export class PmAutopilot {
  private batches = new Map<string, BoardBatch>();

  constructor(private readonly deps: PmAutopilotDeps) {}

  /** Wired as a second onEvent consumer. Never throws into the store. */
  onEvent(event: TaskEvent): void {
    try {
      if (!this.deps.getConfig().autopilotEnabled) return;
      if (!TRIGGER_KINDS.has(event.kind)) return;
      const boardId = this.deps.getBoardForTask(event.taskId);
      if (!boardId) return;
      this.buffer(boardId, event);
    } catch (err) {
      this.deps.log('pm-autopilot onEvent failed', {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /** Cancel all pending timers (app shutdown). */
  dispose(): void {
    for (const b of this.batches.values()) {
      if (b.coalesceTimer) clearTimeout(b.coalesceTimer);
      if (b.gapTimer) clearTimeout(b.gapTimer);
    }
    this.batches.clear();
  }

  private batch(boardId: string): BoardBatch {
    let b = this.batches.get(boardId);
    if (!b) {
      b = { events: [], coalesceTimer: null, nextAllowedAt: 0, gapTimer: null };
      this.batches.set(boardId, b);
    }
    return b;
  }

  private buffer(boardId: string, event: TaskEvent): void {
    const b = this.batch(boardId);
    b.events.push(event);
    if (b.coalesceTimer) return; // a flush is already scheduled
    const { coalesceWindowMs } = this.deps.getConfig();
    b.coalesceTimer = setTimeout(() => {
      b.coalesceTimer = null;
      if (!this.batches.has(boardId)) return; // disposed; don't resurrect the entry
      this.maybeFlush(boardId);
    }, coalesceWindowMs);
  }

  private maybeFlush(boardId: string): void {
    const b = this.batch(boardId);
    if (b.events.length === 0) return;
    const { eventMinGapMs } = this.deps.getConfig();
    const now = this.deps.now();
    if (now < b.nextAllowedAt) {
      // Inside the min-gap: defer the flush to the watermark (once).
      b.gapTimer ??= setTimeout(() => {
        b.gapTimer = null;
        if (!this.batches.has(boardId)) return; // disposed; don't resurrect the entry
        this.maybeFlush(boardId);
      }, b.nextAllowedAt - now);
      return;
    }
    const events = b.events;
    b.events = [];
    b.nextAllowedAt = now + eventMinGapMs;
    const prompt = this.deps.buildBriefing(events);
    void this.deps.runTurn(boardId, prompt, 'event').catch((err) => {
      this.deps.log('pm-autopilot turn failed', {
        boardId,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  }
}

/** Build a compact, structured event-turn prompt from a coalesced batch. */
export function buildEventBriefing(
  events: TaskEvent[],
  resolveTitle: (taskId: string) => string | null
): string {
  const lines = events.map((e) => {
    const title = resolveTitle(e.taskId);
    const label = title ? `${e.taskId} "${title}"` : e.taskId;
    return `- ${e.kind}: ${label}`;
  });
  return [
    'Board activity since your last turn (autopilot):',
    ...lines,
    '',
    'Triage this: unblock or reassign stuck work, arm decompose/specify where',
    'useful, and propose any merge/complete/archive that is clearly ready',
    '(use kanban_propose — those need human confirmation). Keep it brief.'
  ].join('\n');
}
