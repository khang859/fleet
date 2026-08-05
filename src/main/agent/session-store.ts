import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  encodeEvent,
  replaySession,
  sessionHeader,
  type AgentSessionEvent,
  type AgentSessionReplay
} from '../../shared/agent-session';
import { createLogger } from '../logger';

const log = createLogger('agent:sessions');

/**
 * Agent sessions on disk, one JSONL file per thread.
 *
 * Flat, named by session id, with the folder recorded inside the file rather
 * than in the path. The pane already knows its own id, so loading is a single
 * open with nothing to look up, and there is no derived key - a hash or a
 * slugged path - that can disagree with the file it points at.
 *
 * Writes are synchronous appends. A turn is a handful of lines a minute apart,
 * so there is nothing to batch, and doing it synchronously means a line is on
 * disk before the renderer is told the turn ended rather than some time after.
 */

const SESSIONS_DIR = join(homedir(), '.fleet', 'agent', 'sessions');

export class AgentSessionStore {
  constructor(private readonly dir: string = SESSIONS_DIR) {}

  private path(sessionId: string): string {
    return join(this.dir, `${sessionId}.jsonl`);
  }

  /**
   * Append one event, creating the session file on the first write.
   *
   * `cwd` is only used for that first write - it is what the header records.
   * Deferring creation to the first event means a pane opened and closed
   * without a word leaves nothing behind.
   */
  append(sessionId: string, cwd: string, event: AgentSessionEvent): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const header = existsSync(this.path(sessionId))
        ? ''
        : encodeEvent(sessionHeader(sessionId, cwd, new Date().toISOString()));
      appendFileSync(this.path(sessionId), header + encodeEvent(event), 'utf8');
    } catch (err) {
      // A session that cannot be written is not a reason to lose the turn that
      // is on screen: the thread lives in the renderer either way.
      log.warn('append failed', { sessionId, error: String(err) });
    }
  }

  /** The thread this session left behind, or an empty one if there is no file. */
  load(sessionId: string): AgentSessionReplay {
    try {
      const replay = replaySession(readFileSync(this.path(sessionId), 'utf8'));
      if (replay.skipped > 0) log.warn('skipped unreadable lines', { sessionId, ...replay });
      return replay;
    } catch (err) {
      if (!isMissing(err)) log.warn('load failed', { sessionId, error: String(err) });
      return { messages: [], contextTokens: null, cwd: null, skipped: 0 };
    }
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
