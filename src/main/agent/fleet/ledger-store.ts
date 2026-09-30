import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentSessionId } from '../../../shared/agent-session';
import type { ClaudeSession, ClaudeSessionChange } from '../../../shared/claude-sessions';
import { createLogger } from '../../logger';
import { AGENT_SESSIONS_DIR } from '../session-store';

const log = createLogger('agent:fleet-ledger');

/**
 * What an orchestrator conversation remembers about the sessions it watches,
 * one file per conversation next to its session log.
 *
 * Main owns it rather than the pane, so compacting the conversation cannot
 * lose it, and so a subagent reading on the conversation's behalf can be kept
 * from moving it.
 */

/** How far an orchestrator conversation has read one session. */
export const FleetCursor = z.object({
  /** The session read; a different one behind the same ref means it was cleared. */
  sessionId: z.string(),
  epoch: z.number().int(),
  /** The brief revision last shown. */
  rev: z.number().int().min(0),
  /** The last finished turn shown. */
  turn: z.number().int().min(0)
});
export type FleetCursor = z.infer<typeof FleetCursor>;

/**
 * One prompt the Orchestrator sent, or one session it started, and what it
 * expects back.
 *
 * - `open`: sent, and the session has not finished the turn it started.
 * - `answered`: the session finished that turn and waits for a prompt again.
 * - `ended`: the session went away first.
 */
export const FleetLedgerEntry = z.object({
  /** `#1`, `#2`, ... within one conversation. */
  id: z.string(),
  action: z.enum(['send', 'spawn']),
  /** The session's ref, which is its pane's. */
  ref: z.string(),
  paneId: z.string(),
  /** The session typed into. For a spawn, null until the new session reports. */
  sessionId: z.string().nullable(),
  /** The session's epoch when the prompt went in; a later one means it was cleared. */
  epoch: z.number().nullable(),
  /** The start of the prompt, enough to recognise it. */
  prompt: z.string(),
  why: z.string(),
  expect: z.string(),
  at: z.number(),
  /** The session has started working on the prompt. */
  started: z.boolean(),
  state: z.enum(['open', 'answered', 'ended']),
  settledAt: z.number().nullable()
});
export type FleetLedgerEntry = z.infer<typeof FleetLedgerEntry>;

const LedgerFile = z.object({
  cursors: z.record(z.string(), FleetCursor),
  entries: z.array(FleetLedgerEntry).default([]),
  /** The number the next entry gets. */
  next: z.number().int().min(1).default(1)
});
type LedgerFile = z.infer<typeof LedgerFile>;

const emptyFile = (): LedgerFile => ({ cursors: {}, entries: [], next: 1 });

/** Sessions one conversation keeps a cursor for; the least recently read go first. */
const MAX_CURSORS = 100;
/** Entries one conversation keeps; settled ones are dropped first, oldest first. */
const MAX_ENTRIES = 50;
/** How much of a prompt an entry keeps. */
const PROMPT_EXCERPT_CHARS = 200;

export type NewLedgerEntry = Pick<
  FleetLedgerEntry,
  'action' | 'ref' | 'paneId' | 'sessionId' | 'epoch' | 'why' | 'expect' | 'at'
> & {
  prompt: string;
  /** The prompt is known to have gone in: a send Claude Code acknowledged. */
  started: boolean;
};

function settleEntry(
  entry: FleetLedgerEntry,
  session: ClaudeSession | undefined,
  now: number,
  startingPanes: ReadonlySet<string> = new Set()
): boolean {
  if (session === undefined) {
    // A spawned tab whose session has not reported yet is still on its way.
    if (entry.sessionId === null && startingPanes.has(entry.paneId)) return false;
    return end(entry, now);
  }
  let changed = false;
  if (entry.sessionId === null) {
    entry.sessionId = session.sessionId;
    entry.epoch = session.epoch;
    changed = true;
  }
  // Cleared: the conversation the prompt went to is gone.
  if (session.phase === 'ended' || session.epoch !== entry.epoch) return end(entry, now);
  const waiting = session.phase === 'waitingForInput' && session.waitingKind === 'prompt';
  if (!entry.started && !waiting && session.phase !== 'starting') {
    entry.started = true;
    changed = true;
  }
  if (entry.started && waiting && session.phaseSince >= entry.at) {
    entry.state = 'answered';
    entry.settledAt = session.phaseSince;
    changed = true;
  }
  return changed;
}

function end(entry: FleetLedgerEntry, now: number): true {
  entry.state = 'ended';
  entry.settledAt = now;
  return true;
}

/** The running session an entry is about: by id, or for a spawn not yet reported, by pane. */
function sessionFor(
  entry: FleetLedgerEntry,
  sessions: readonly ClaudeSession[]
): ClaudeSession | undefined {
  return entry.sessionId === null
    ? sessions.find((s) => s.paneId === entry.paneId)
    : sessions.find((s) => s.sessionId === entry.sessionId);
}

export class FleetLedgerStore {
  private readonly cache = new Map<string, LedgerFile>();

  constructor(private readonly dir: string = AGENT_SESSIONS_DIR) {}

  cursor(threadId: string, ref: string): FleetCursor | null {
    return this.load(threadId).cursors[ref] ?? null;
  }

  setCursor(threadId: string, ref: string, cursor: FleetCursor): void {
    const file = this.load(threadId);
    // Deleted and re-added, so key order is least recently read first.
    delete file.cursors[ref];
    file.cursors[ref] = cursor;
    const refs = Object.keys(file.cursors);
    for (const old of refs.slice(0, Math.max(0, refs.length - MAX_CURSORS))) {
      delete file.cursors[old];
    }
    this.save(threadId, file);
  }

  /** Record a send or a spawn. Returns the entry as written. */
  addEntry(threadId: string, entry: NewLedgerEntry): FleetLedgerEntry {
    const file = this.load(threadId);
    const prompt =
      entry.prompt.length > PROMPT_EXCERPT_CHARS
        ? `${entry.prompt.slice(0, PROMPT_EXCERPT_CHARS)}…`
        : entry.prompt;
    const written: FleetLedgerEntry = {
      ...entry,
      prompt,
      id: `#${file.next}`,
      state: 'open',
      settledAt: null
    };
    file.next++;
    file.entries.push(written);
    while (file.entries.length > MAX_ENTRIES) {
      const settled = file.entries.findIndex((e) => e.state !== 'open');
      file.entries.splice(settled === -1 ? 0 : settled, 1);
    }
    this.save(threadId, file);
    return written;
  }

  entries(threadId: string): FleetLedgerEntry[] {
    return [...this.load(threadId).entries];
  }

  /**
   * Move entries along as a session changes, in every conversation this run of
   * Fleet has loaded. Conversations it has not are brought up to date by
   * `reconcile` when they are next used.
   */
  observe(change: ClaudeSessionChange, now = Date.now()): void {
    for (const [threadId, file] of this.cache) {
      let changed = false;
      for (const entry of file.entries) {
        if (entry.state !== 'open') continue;
        const mine =
          entry.sessionId === null
            ? change.session?.paneId === entry.paneId
            : change.sessionId === entry.sessionId;
        if (mine && settleEntry(entry, change.session ?? undefined, now)) changed = true;
      }
      if (changed) this.save(threadId, file);
    }
  }

  /**
   * Bring a conversation's open entries up to date with the running sessions,
   * and the spawned panes whose session has not reported yet.
   */
  reconcile(
    threadId: string,
    sessions: readonly ClaudeSession[],
    startingPanes: ReadonlySet<string>,
    now = Date.now()
  ): void {
    const file = this.load(threadId);
    let changed = false;
    for (const entry of file.entries) {
      if (entry.state !== 'open') continue;
      if (settleEntry(entry, sessionFor(entry, sessions), now, startingPanes)) changed = true;
    }
    if (changed) this.save(threadId, file);
  }

  /** Forget a conversation, when its session is deleted. */
  delete(threadId: string): void {
    this.cache.delete(threadId);
    const path = this.path(threadId);
    if (path === null) return;
    try {
      rmSync(path, { force: true });
    } catch (err) {
      log.warn('could not delete ledger', { threadId, error: String(err) });
    }
  }

  /** Only a uuid names a file, so no id can walk out of the folder. */
  private path(threadId: string): string | null {
    return AgentSessionId.safeParse(threadId).success
      ? join(this.dir, `${threadId}.fleet.json`)
      : null;
  }

  private load(threadId: string): LedgerFile {
    const cached = this.cache.get(threadId);
    if (cached) return cached;
    const file = this.read(threadId);
    this.cache.set(threadId, file);
    return file;
  }

  private read(threadId: string): LedgerFile {
    const path = this.path(threadId);
    if (path === null) return emptyFile();
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return emptyFile();
    }
    try {
      const parsed = LedgerFile.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      log.warn('ledger has an unexpected shape; starting a new one', { threadId });
    } catch {
      log.warn('ledger is not JSON; starting a new one', { threadId });
    }
    return emptyFile();
  }

  /** Through a temporary file and a rename, so a crash leaves the old file whole. */
  private save(threadId: string, file: LedgerFile): void {
    const path = this.path(threadId);
    if (path === null) return; // kept in memory only
    const temp = `${path}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(temp, JSON.stringify(file), 'utf8');
      renameSync(temp, path);
    } catch (err) {
      log.warn('could not write ledger', { threadId, error: String(err) });
    }
  }
}
