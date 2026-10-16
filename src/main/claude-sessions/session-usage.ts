import { estimateSessionCostUsd, type PriceTable } from '../../shared/claude-pricing';
import type { ClaudeSessionUsage } from '../../shared/claude-sessions';
import { createLogger } from '../logger';
import { SessionTail } from './session-tail';
import { UsageAccumulator } from './usage-accumulator';

const log = createLogger('claude-sessions:usage');

/** How often a busy session's transcript is re-read at most. */
export const USAGE_THROTTLE_MS = 2_000;

/** The context window every current model starts with. */
const STANDARD_CONTEXT = 200_000;
/** The long-context window. A session is on it once its context passes the standard one. */
const LONG_CONTEXT = 1_000_000;

export const UNKNOWN_USAGE: ClaudeSessionUsage = {
  costUsd: null,
  contextTokens: null,
  contextLimit: null
};

/**
 * The context window to measure against. The transcript names the model but
 * not whether it runs with the 1M window, so a session counts as 1M once it
 * has been seen above 200k, and stays so after compacting.
 */
export function contextLimitFor(tokens: number, seenLong: boolean): number {
  return seenLong || tokens > STANDARD_CONTEXT ? LONG_CONTEXT : STANDARD_CONTEXT;
}

type Tracked = {
  transcriptPath: string;
  acc: UsageAccumulator;
  tail: SessionTail;
  seenLong: boolean;
  usage: ClaudeSessionUsage;
  lastRun: number;
  running: Promise<void> | null;
  again: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export type SessionUsageOptions = {
  priceTable: () => PriceTable;
  /** Called when a session's usage changed. */
  onChange: (sessionId: string) => void;
  throttleMs?: number;
  now?: () => number;
};

/**
 * Cost and context estimates per session, from its transcript and its
 * subagents' transcripts. Each file is read from where the last read stopped,
 * so a long session is never re-read whole.
 */
export class SessionUsageTracker {
  private readonly tracked = new Map<string, Tracked>();
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: SessionUsageOptions) {
    this.throttleMs = opts.throttleMs ?? USAGE_THROTTLE_MS;
    this.now = opts.now ?? Date.now;
  }

  get(sessionId: string): ClaudeSessionUsage {
    return this.tracked.get(sessionId)?.usage ?? UNKNOWN_USAGE;
  }

  /**
   * Re-read a session's transcripts soon: at once when `immediate` (a turn
   * just ended) or when the last read is old enough, otherwise once the
   * throttle window passes.
   */
  refresh(sessionId: string, transcriptPath: string, immediate = false): void {
    let t = this.tracked.get(sessionId);
    if (t?.transcriptPath !== transcriptPath) {
      if (t?.timer) clearTimeout(t.timer);
      t = {
        transcriptPath,
        acc: new UsageAccumulator(),
        tail: new SessionTail(transcriptPath),
        seenLong: false,
        usage: UNKNOWN_USAGE,
        lastRun: 0,
        running: null,
        again: false,
        timer: null
      };
      this.tracked.set(sessionId, t);
    }
    const wait = this.throttleMs - (this.now() - t.lastRun);
    if (immediate || wait <= 0) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      this.run(sessionId, t);
    } else if (!t.timer) {
      const entry = t;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.run(sessionId, entry);
      }, wait);
      entry.timer.unref();
    }
  }

  /** Wait for any read in progress for a session; for tests and shutdown. */
  async settled(sessionId: string): Promise<void> {
    let t = this.tracked.get(sessionId);
    while (t?.running) {
      await t.running;
      t = this.tracked.get(sessionId);
    }
  }

  forget(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (t?.timer) clearTimeout(t.timer);
    this.tracked.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.tracked.keys()]) this.forget(sessionId);
  }

  private run(sessionId: string, t: Tracked): void {
    if (t.running) {
      t.again = true;
      return;
    }
    t.lastRun = this.now();
    t.running = this.read(t)
      .then(() => {
        if (this.tracked.get(sessionId) !== t) return;
        const next = this.usageOf(t);
        if (!sameUsage(next, t.usage)) {
          t.usage = next;
          this.opts.onChange(sessionId);
        }
      })
      .catch((err: unknown) => {
        log.debug('could not read transcript', { sessionId, error: String(err) });
      })
      .finally(() => {
        t.running = null;
        if (t.again && this.tracked.get(sessionId) === t) {
          t.again = false;
          this.run(sessionId, t);
        }
      });
  }

  private async read(t: Tracked): Promise<void> {
    await t.tail.read(
      (line) => t.acc.addLine(line),
      // A file got shorter, so it was replaced: start the totals over.
      () => (t.acc = new UsageAccumulator())
    );
  }

  private usageOf(t: Tracked): ClaudeSessionUsage {
    const agg = t.acc.result();
    const cost = agg.hasUsage
      ? estimateSessionCostUsd(agg.perModel, this.opts.priceTable())
      : undefined;
    const tokens = agg.context?.tokens ?? null;
    if (tokens !== null && tokens > STANDARD_CONTEXT) t.seenLong = true;
    return {
      costUsd: cost ?? null,
      contextTokens: tokens,
      contextLimit: tokens === null ? null : contextLimitFor(tokens, t.seenLong)
    };
  }
}

function sameUsage(a: ClaudeSessionUsage, b: ClaudeSessionUsage): boolean {
  return (
    a.costUsd === b.costUsd &&
    a.contextTokens === b.contextTokens &&
    a.contextLimit === b.contextLimit
  );
}
