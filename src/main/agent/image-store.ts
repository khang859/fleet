import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentSessionId } from '../../shared/agent-session';
import { realpathOrNearest } from './tools/paths';
import { createLogger } from '../logger';

const log = createLogger('agent:images');

/**
 * Images a conversation owns, on disk beside its sessions.
 *
 * Two roots, one class. What the agent generated is not a change to the
 * project, and dropping one into a repo because a model asked for it would be a
 * write the user never authorised; what the user pasted or dropped never had a
 * home of its own, or had one that may be gone tomorrow. Both land here instead
 * of in the working folder, and reach the project only if someone puts them
 * there.
 *
 * One folder per conversation either way, so the images go when the
 * conversation does. A stray folder is not just wasted disk - it is a picture
 * the user thought they had deleted.
 */

/** Where the agent's own output goes, one folder per conversation. Exported so
 *  the gallery can read the whole store rather than one session at a time. */
export const AGENT_IMAGES_DIR = join(homedir(), '.fleet', 'agent', 'images');

/** Where an attachment is copied to. Separate from what the agent generated:
 *  they are deleted together, but they are not the same thing, and a folder
 *  that mixes them cannot say which picture came from whom. */
export const AGENT_ATTACHMENTS_DIR = join(homedir(), '.fleet', 'agent', 'attachments');

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg'
};

/** Whether a real path sits inside a real root. */
function within(root: string, path: string): boolean {
  const rel = relative(realpathOrNearest(root), realpathOrNearest(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Whether a path is one Fleet put a picture at.
 *
 * The two folders here are the only places outside the working folder that a
 * picture may be read from, which is what lets a pasted screenshot and an image
 * the agent drew be sent at all - they have no home in the project, and the
 * sandbox that guards everything else would refuse them.
 */
export function isAgentImagePath(path: string): boolean {
  return within(AGENT_IMAGES_DIR, path) || within(AGENT_ATTACHMENTS_DIR, path);
}

export class AgentImageStore {
  constructor(private readonly root: string = AGENT_IMAGES_DIR) {}

  /**
   * Where one conversation's images live, for an id allowed to name a folder.
   *
   * The same guard the session store uses, for the same reason: every real id
   * is a `crypto.randomUUID()`, so a uuid is the whole shape, and this is the
   * only place one becomes a path. A thread id arrives over IPC from the
   * renderer, and `..` is a perfectly good string.
   */
  private dirFor(threadId: string): string | null {
    if (!AgentSessionId.safeParse(threadId).success) {
      log.warn('refused a thread id that is not a uuid', { threadId });
      return null;
    }
    return join(this.root, threadId);
  }

  /** Save one image and return its absolute path. */
  save(threadId: string, data: Uint8Array, mimeType: string): string {
    const dir = this.dirFor(threadId);
    if (dir === null) throw new Error('That conversation cannot hold images');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.${EXT_BY_MIME[mimeType] ?? 'png'}`);
    writeFileSync(path, data);
    return path;
  }

  /** Forget one conversation's images, when the conversation is deleted. */
  remove(threadId: string): void {
    const dir = this.dirFor(threadId);
    if (dir === null) return;
    rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Drop every folder no live conversation answers for.
   *
   * Deleting a session takes its pictures with it, so this is for the ones that
   * lost their conversation some other way: a pane too old to have a session at
   * all, whose files were filed under the pane's own id and can never be
   * matched again, and a crash between saving a picture and writing the line
   * that mentions it.
   *
   * Called once at startup and nowhere else, because it is safe exactly then.
   * A conversation writes its session file on its first message, so a picture
   * attached but not yet sent is a folder with no session - and sweeping while
   * the app is running would delete it out from under the composer.
   */
  sweep(live: Set<string>): void {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (live.has(name)) continue;
      try {
        rmSync(join(this.root, name), { recursive: true, force: true });
        log.info('removed pictures no conversation answers for', { threadId: name });
      } catch (err) {
        log.warn('sweep failed', { threadId: name, error: String(err) });
      }
    }
  }

  /**
   * Whether a path is one of ours.
   *
   * What lets the image tool accept `references` pointing at its own earlier
   * output: those live outside the working folder, so the sandbox that guards
   * every other path would refuse them, and this is the one other place a file
   * may be read from. It answers about the whole store rather than one thread -
   * a conversation that resumed under a new session id would otherwise be
   * unable to cite the pictures it just made.
   *
   * Checked against the real path, the way the working-folder sandbox is, so a
   * symlink dropped in here cannot be used to read something else.
   */
  contains(path: string): boolean {
    return within(this.root, path);
  }
}
