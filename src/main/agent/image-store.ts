import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentSessionId } from '../../shared/agent-session';
import { realpathOrNearest } from './tools/paths';
import { createLogger } from '../logger';

const log = createLogger('agent:images');

/**
 * Images the agent generated, on disk beside its sessions.
 *
 * Outside the working folder on purpose: a generated picture is not a change to
 * the project, and dropping one into a repo because a model asked for it would
 * be a write the user never authorised. It lands here instead, and reaches the
 * project only if someone copies it there.
 *
 * One folder per conversation, so the images go when the conversation does.
 * A stray folder is not just wasted disk - it is a picture the user thought
 * they had deleted.
 */

const IMAGES_DIR = join(homedir(), '.fleet', 'agent', 'images');

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
};

export class AgentImageStore {
  constructor(private readonly root: string = IMAGES_DIR) {}

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
    const rel = relative(realpathOrNearest(this.root), realpathOrNearest(path));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }
}
