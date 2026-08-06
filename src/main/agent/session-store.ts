import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AgentSessionId,
  emptyReplay,
  encodeEvent,
  replaySession,
  sessionHeader,
  type AgentSessionEvent,
  type AgentSessionListItem,
  type AgentSessionReplay
} from '../../shared/agent-session';
import { AGENT_ATTACHMENTS_DIR, AgentImageStore } from './image-store';
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
  constructor(
    private readonly dir: string = SESSIONS_DIR,
    /** The images those sessions generated, so deleting one removes both. */
    private readonly images: AgentImageStore = new AgentImageStore(),
    /** And the ones the user attached to them, which go the same way. */
    private readonly attachments: AgentImageStore = new AgentImageStore(AGENT_ATTACHMENTS_DIR)
  ) {}

  /**
   * Where a session lives, for an id that is allowed to name one.
   *
   * Every id that reaches this class came over IPC, and this is the only place
   * one becomes a path - so the shape is checked here rather than at each
   * caller, where it is one handler's turn to be forgotten. Every real id is
   * minted by `crypto.randomUUID()`, so a uuid is the whole shape, and nothing
   * that is not one can walk out of the sessions folder.
   */
  private path(sessionId: string): string | null {
    if (!AgentSessionId.safeParse(sessionId).success) {
      log.warn('refused a session id that is not a uuid', { sessionId });
      return null;
    }
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
    const path = this.path(sessionId);
    if (path === null) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      const exists = existsSync(path);
      // Only something that was said can begin a session. A `title` or a
      // `context` is about a conversation rather than part of one, so arriving
      // for a file that is gone means the session was deleted while the work
      // that produced it was in flight - and writing it would put a session
      // back in the list holding nothing but its own name.
      if (!exists && event.t !== 'message') return;
      const header = exists
        ? ''
        : encodeEvent(sessionHeader(sessionId, cwd, new Date().toISOString()));
      appendFileSync(path, header + encodeEvent(event), 'utf8');
    } catch (err) {
      // A session that cannot be written is not a reason to lose the turn that
      // is on screen: the thread lives in the renderer either way.
      log.warn('append failed', { sessionId, error: String(err) });
    }
  }

  /** The thread this session left behind, or an empty one if there is no file. */
  load(sessionId: string): AgentSessionReplay {
    const path = this.path(sessionId);
    if (path === null) return emptyReplay();
    try {
      const replay = replaySession(readFileSync(path, 'utf8'));
      if (replay.skipped > 0) log.warn('skipped unreadable lines', { sessionId, ...replay });
      return replay;
    } catch (err) {
      if (!isMissing(err)) log.warn('load failed', { sessionId, error: String(err) });
      return emptyReplay();
    }
  }

  /**
   * The sessions started in `cwd`, most recently used first.
   *
   * Every file has to be opened to know which folder it belongs to, since the
   * folder is recorded inside the file rather than in its name. That is the
   * price of the flat layout, and it buys a listing that cannot disagree with
   * the sessions it lists.
   */
  list(cwd: string): AgentSessionListItem[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'));
    } catch (err) {
      if (!isMissing(err)) log.warn('list failed', { error: String(err) });
      return [];
    }

    const items: AgentSessionListItem[] = [];
    for (const name of names) {
      const id = name.slice(0, -'.jsonl'.length);
      const path = this.path(id);
      if (path === null) continue;
      try {
        const replay = replaySession(readHead(path));
        // No header means this is not one of ours, which is how a stray file
        // in the folder stays out of the list.
        if (replay.cwd !== cwd) continue;
        items.push({
          id,
          cwd: replay.cwd,
          title: replay.title,
          firstUserText: replay.firstUserText,
          // Last written is last used: an append is the only thing that ever
          // touches one of these files, so the mtime needs no help from the log.
          updatedAt: statSync(path).mtimeMs
        });
      } catch (err) {
        // One unreadable session is not a reason to show the user none.
        log.warn('list: unreadable session', { id, error: String(err) });
      }
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Remove a session's file, and the images it generated. A session that is
   * already gone counts as removed: there is nothing left either way, and
   * saying otherwise would put an error in front of the user for the outcome
   * they asked for.
   *
   * The images go first, generated and attached alike. A picture that outlives
   * the conversation it belongs to is not wasted disk - it is something the
   * user believes they deleted, still sitting in their home folder.
   */
  delete(sessionId: string): boolean {
    const path = this.path(sessionId);
    if (path === null) return false;
    this.images.remove(sessionId);
    this.attachments.remove(sessionId);
    try {
      unlinkSync(path);
      return true;
    } catch (err) {
      if (isMissing(err)) return true;
      log.warn('delete failed', { sessionId, error: String(err) });
      return false;
    }
  }
}

/**
 * How much of a session file the listing is willing to read.
 *
 * Everything a row needs - the folder, the opening words, the title - is
 * written in the first turn or two, while the rest of the file is transcript
 * the list never shows. A session with a long first turn can push its title
 * past this, and then the row falls back to the words it opened with, which is
 * the same thing an untitled session shows. That is a better trade than
 * parsing megabytes on the main thread every time the tab is opened.
 */
const LIST_SCAN_BYTES = 256 * 1024;

/**
 * The first `LIST_SCAN_BYTES` of a file, as text.
 *
 * The slice usually ends mid-line, which needs no handling here: `replaySession`
 * already skips a line it cannot read, because a crash during an append leaves
 * exactly the same thing behind.
 */
function readHead(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(LIST_SCAN_BYTES);
    const read = readSync(fd, buffer, 0, LIST_SCAN_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
