import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Expand a leading `~/` and anchor a relative override against the home dir
 * (a stable base — never `process.cwd()`, which is `/` when launched from Finder).
 */
function resolveOverride(p: string): string {
  const expanded = p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(1)) : p;
  return resolve(homedir(), expanded);
}

/**
 * Owns each conversation's on-disk folder under `~/.fleet/chat/{id}/`:
 *
 *   ~/.fleet/chat/{id}/workspace/  ← agent cwd + writable + read + @-mention root
 *   ~/.fleet/chat/{id}/images/     ← generated images + attachments
 *
 * When the user sets an explicit `workspaceDir`, the agent cwd follows that
 * instead; image storage always stays in the per-conversation folder.
 */
export class ChatWorkspace {
  constructor(
    private readonly baseDir: string,
    /** Pre-existing image location, removed alongside the new folder on delete. */
    private readonly legacyImagesDir: string
  ) {}

  /** Reject ids that could escape or delete the base dir (`''`, `.`, `..`, separators). */
  private assertId(id: string): void {
    if (!id || id === '.' || id === '..' || /[/\\\0]/.test(id)) {
      throw new Error(`Invalid conversation id: ${JSON.stringify(id)}`);
    }
  }

  /**
   * The agent's cwd / writable root / read root / `@`-mention root for a
   * conversation. An explicit `configured` override wins; otherwise the
   * per-session `workspace/` folder, created lazily.
   */
  resolve(configured: string | null, conversationId: string): string {
    if (configured) return resolveOverride(configured);
    this.assertId(conversationId);
    const dir = join(this.baseDir, conversationId, 'workspace');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Per-conversation image/attachment directory (independent of any override). */
  imagesDir(conversationId: string): string {
    this.assertId(conversationId);
    const dir = join(this.baseDir, conversationId, 'images');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** The session root (workspace + images), created on demand — for Reveal in Finder. */
  sessionDir(conversationId: string): string {
    this.assertId(conversationId);
    const dir = join(this.baseDir, conversationId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Remove the conversation's session folder and any legacy image folder. */
  delete(conversationId: string): void {
    this.assertId(conversationId);
    rmSync(join(this.baseDir, conversationId), { recursive: true, force: true });
    rmSync(join(this.legacyImagesDir, conversationId), { recursive: true, force: true });
  }
}
