import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentSessionId } from '../../../shared/agent-session';
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

const LedgerFile = z.object({ cursors: z.record(z.string(), FleetCursor) });
type LedgerFile = z.infer<typeof LedgerFile>;

/** Sessions one conversation keeps a cursor for; the least recently read go first. */
const MAX_CURSORS = 100;

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
    if (path === null) return { cursors: {} };
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return { cursors: {} };
    }
    try {
      const parsed = LedgerFile.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      log.warn('ledger has an unexpected shape; starting a new one', { threadId });
    } catch {
      log.warn('ledger is not JSON; starting a new one', { threadId });
    }
    return { cursors: {} };
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
