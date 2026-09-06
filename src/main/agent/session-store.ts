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
  lastSpendIn,
  replaySession,
  sessionHeader,
  type AgentSessionEvent,
  type AgentSessionListItem,
  type AgentSessionReplay
} from '../../shared/agent-session';
import {
  addTurn,
  hasSpend,
  EMPTY_SESSION_SPEND,
  type AgentSessionSpend
} from '../../shared/agent-spend';
import type { AgentTurnUsage } from '../../shared/agent-types';
import { AGENT_ATTACHMENTS_DIR, AgentImageStore } from './image-store';
import { ensureScratchSessionDir, isScratchDir } from './scratch-dir';
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

  /**
   * Add what one turn spent to a session's running total.
   *
   * Read, add, write, in one synchronous step here rather than in the pane,
   * because the total is cumulative and the pane may not have the session open
   * to add to. That is the case this exists for: a subagent reports back
   * minutes after the pane that dispatched it moved on, and its bill belongs to
   * the session that asked for it whether or not anything is still showing it.
   * Two children finishing at once on the same closed session would race a
   * read-modify-write done anywhere else.
   */
  addSpend(sessionId: string, cwd: string, usage: AgentTurnUsage): void {
    this.append(sessionId, cwd, {
      t: 'spend',
      total: addTurn(this.runningTotal(sessionId), usage)
    });
  }

  /**
   * What a session has spent so far, without replaying it.
   *
   * The total is rewritten in full after every turn, so the newest one is the
   * last of its kind in the file and near the end of it. Reading the tail is
   * what the listing already does; doing it here too is what keeps the cost of
   * a turn from growing with the length of the conversation, which is the shape
   * that hurts - a long session paying a full synchronous read and parse of
   * itself every time a bill lands, including once per subagent that reports.
   *
   * A tail that holds no total is not taken as zero. A single turn long enough
   * to push the last one out of the window is rare but not impossible, and
   * reading it as nothing would silently reset what the user has spent. That
   * case falls back to the whole file, which is what this used to do always.
   */
  private runningTotal(sessionId: string): AgentSessionSpend {
    const path = this.path(sessionId);
    if (path === null) return EMPTY_SESSION_SPEND;
    try {
      const size = statSync(path).size;
      if (size > SPEND_TAIL_BYTES) {
        const tail = lastSpendIn(readWindow(path, size - SPEND_TAIL_BYTES, SPEND_TAIL_BYTES));
        if (tail !== null) return tail;
      }
    } catch (err) {
      if (!isMissing(err)) log.warn('spend tail read failed', { sessionId, error: String(err) });
    }
    return this.load(sessionId).spend;
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

  /** Resolve a Scratch chat's folder while restoring its transcript. */
  loadScratch(sessionId: string): AgentSessionReplay {
    const replay = this.load(sessionId);
    if (replay.cwd !== null && !isScratchDir(replay.cwd)) return replay;
    return { ...replay, cwd: ensureScratchSessionDir(sessionId, replay.cwd) };
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
        const info = statSync(path);
        const replay = replaySession(readHead(path));
        // No header means this is not one of ours, which is how a stray file
        // in the folder stays out of the list.
        if (isScratchDir(cwd) ? !isScratchDir(replay.cwd ?? '') : replay.cwd !== cwd) continue;
        if (replay.cwd === null) continue;
        items.push({
          id,
          cwd: replay.cwd,
          title: replay.title,
          firstUserText: replay.firstUserText,
          // Last written is last used: an append is the only thing that ever
          // touches one of these files, so the mtime needs no help from the log.
          updatedAt: info.mtimeMs,
          spend: readSpend(path, info.size, replay)
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

  /**
   * Throw away pictures whose conversation is gone.
   *
   * Deleting a session takes its own with it, so what is left here belongs to
   * conversations that ended some other way - most of all panes from before
   * sessions existed, which filed their files under the pane's id and left them
   * behind for good. Without this the two folders only ever grow.
   */
  sweep(): void {
    let live: Set<string>;
    try {
      live = new Set(
        readdirSync(this.dir)
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => name.slice(0, -'.jsonl'.length))
      );
    } catch (err) {
      // No sessions folder at all is a first run, not an empty one: sweeping
      // against a set that is empty for the wrong reason would delete
      // everything the user has.
      if (!isMissing(err)) log.warn('sweep: could not list sessions', { error: String(err) });
      return;
    }
    this.images.sweep(live);
    this.attachments.sweep(live);
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
 * How much of the *end* of a file the listing reads, to find what it spent.
 *
 * The running total is rewritten after every turn, so the newest one is within
 * a few lines of the end however long the conversation ran. Small, because it
 * only ever has to contain one line - the extra room is for the turn that
 * happened to end with a long reply in front of it.
 */
const LIST_TAIL_BYTES = 16 * 1024;

/**
 * How much of the end of a file `addSpend` reads to find the running total.
 *
 * Larger than the listing's window because missing here is worse than missing
 * there: the listing shows a dash, this one would fall back to reading the
 * whole file. Still small enough that a turn's cost does not depend on how long
 * the conversation has been going.
 */
const SPEND_TAIL_BYTES = 64 * 1024;

/**
 * The first `LIST_SCAN_BYTES` of a file, as text.
 *
 * The slice usually ends mid-line, which needs no handling here: `replaySession`
 * already skips a line it cannot read, because a crash during an append leaves
 * exactly the same thing behind.
 */
function readHead(path: string): string {
  return readWindow(path, 0, LIST_SCAN_BYTES);
}

/**
 * What a session spent, without replaying it.
 *
 * The head is read anyway, so a file that fits inside it has already been fully
 * parsed and there is nothing to go back for. Only a longer one needs the tail,
 * where the newest running total is - and past that point the head is far too
 * early to hold it, since it was written before most of the money was spent.
 *
 * `null` when there is no total anywhere: a session from before this was
 * recorded, which the row shows as a dash rather than as zero.
 */
function readSpend(path: string, size: number, head: AgentSessionReplay): AgentSessionSpend | null {
  if (size <= LIST_SCAN_BYTES) return hasSpend(head.spend) ? head.spend : null;
  const start = Math.max(0, size - LIST_TAIL_BYTES);
  return lastSpendIn(readWindow(path, start, LIST_TAIL_BYTES)) ?? null;
}

/** `length` bytes from `start`, as text, without reading the rest of the file. */
function readWindow(path: string, start: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}
