import { statSync, watch, type FSWatcher } from 'fs';
import { createLogger } from '../logger';
import { BriefBuilder } from './brief';
import type { TranscriptSignal } from './phase';
import { TranscriptTail, type TailLine, type TranscriptEvent } from './transcript';

const log = createLogger('claude-sessions:transcripts');

/** How soon after a transcript changes it is read; writes come in bursts. */
export const TRANSCRIPT_DEBOUNCE_MS = 150;

/**
 * The phase change a transcript event implies, if any. A rejection that
 * carries the user's feedback does not stop the turn: Claude goes on with it.
 */
export function signalOf(event: TranscriptEvent): TranscriptSignal | null {
  switch (event.kind) {
    case 'interrupted':
      return 'turnStopped';
    case 'tool_result':
      return event.rejected && !/the user said:/i.test(event.text) ? 'turnStopped' : null;
    case 'queue':
      return event.operation === 'dequeue' ? 'turnStarted' : null;
    case 'user_prompt':
    case 'assistant_text':
    case 'thinking':
    case 'tool_use':
    case 'clear':
    case 'meta':
      return null;
  }
}

/** Watch a file for changes; returns a way to stop. Injectable for tests. */
export type WatchFile = (path: string, onChange: () => void) => (() => void) | null;

const watchFile: WatchFile = (path, onChange) => {
  let watcher: FSWatcher;
  try {
    watcher = watch(path, { persistent: false }, onChange);
  } catch {
    return null; // not written yet; the next hook event tries again
  }
  watcher.on('error', () => watcher.close());
  return () => watcher.close();
};

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

type Tracked = {
  path: string;
  tail: TranscriptTail;
  brief: BriefBuilder;
  /**
   * The transcript's size when the session's latest hook event arrived. A
   * signal only counts when written after it: the hook event already says
   * everything before.
   */
  mark: number;
  unwatch: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
};

export type SessionTranscriptsOptions = {
  /** The transcript showed a phase change no hook event reported. */
  onSignal: (sessionId: string, signal: TranscriptSignal) => void;
  /** The session's brief changed. */
  onChange?: (sessionId: string) => void;
  watchFile?: WatchFile;
  debounceMs?: number;
};

/** A session's transcript as read so far. */
export type SessionTranscript = {
  path: string;
  tail: TranscriptTail;
  brief: BriefBuilder;
};

/**
 * Follows the transcript of each live session: reads it as it grows, keeps
 * its brief, and reports what hooks miss, such as a permission cancelled in
 * the terminal or a queued prompt starting.
 */
export class SessionTranscripts {
  private readonly tracked = new Map<string, Tracked>();
  private readonly watchFile: WatchFile;
  private readonly debounceMs: number;

  constructor(private readonly opts: SessionTranscriptsOptions) {
    this.watchFile = opts.watchFile ?? watchFile;
    this.debounceMs = opts.debounceMs ?? TRANSCRIPT_DEBOUNCE_MS;
  }

  /**
   * A hook event from the session arrived: remember how far the transcript
   * went at that moment, and read what it gained.
   */
  onHookEvent(sessionId: string, path: string): void {
    const t = this.ensure(sessionId, path);
    t.mark = sizeOf(path);
    t.unwatch ??= this.watchFile(path, () => this.schedule(sessionId));
    this.schedule(sessionId);
  }

  /** The session's transcript, read up to now. */
  async read(sessionId: string): Promise<SessionTranscript | null> {
    const t = this.tracked.get(sessionId);
    if (!t) return null;
    await this.run(sessionId, t);
    return this.tracked.get(sessionId) === t
      ? { path: t.path, tail: t.tail, brief: t.brief }
      : null;
  }

  forget(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t) return;
    t.unwatch?.();
    if (t.timer) clearTimeout(t.timer);
    this.tracked.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of [...this.tracked.keys()]) this.forget(sessionId);
  }

  private ensure(sessionId: string, path: string): Tracked {
    const current = this.tracked.get(sessionId);
    if (current?.path === path) return current;
    if (current) this.forget(sessionId);
    const brief = new BriefBuilder();
    const t: Tracked = {
      path,
      brief,
      tail: new TranscriptTail({
        onLine: (line) => this.onLine(sessionId, t, line),
        onReset: () => {
          t.brief = new BriefBuilder();
        }
      }),
      mark: 0,
      unwatch: null,
      timer: null,
      running: null
    };
    this.tracked.set(sessionId, t);
    return t;
  }

  private onLine(sessionId: string, t: Tracked, line: TailLine): void {
    for (const event of line.events) {
      t.brief.apply(event);
      const signal = line.start >= t.mark ? signalOf(event) : null;
      if (signal) this.opts.onSignal(sessionId, signal);
    }
  }

  private schedule(sessionId: string): void {
    const t = this.tracked.get(sessionId);
    if (!t || t.timer) return;
    t.timer = setTimeout(() => {
      t.timer = null;
      void this.run(sessionId, t);
    }, this.debounceMs);
    t.timer.unref();
  }

  /** Read what the transcript gained. Reads of one session run one after another. */
  private async run(sessionId: string, t: Tracked): Promise<void> {
    const read = (t.running ?? Promise.resolve()).then(async () => this.readOnce(sessionId, t));
    t.running = read;
    await read;
    if (t.running === read) t.running = null;
  }

  private async readOnce(sessionId: string, t: Tracked): Promise<void> {
    if (this.tracked.get(sessionId) !== t) return;
    const rev = t.brief.state.rev;
    try {
      await t.tail.read(t.path);
    } catch (err) {
      log.debug('could not read transcript', { sessionId, error: String(err) });
    }
    if (t.brief.state.rev !== rev && this.tracked.get(sessionId) === t) {
      this.opts.onChange?.(sessionId);
    }
  }
}
