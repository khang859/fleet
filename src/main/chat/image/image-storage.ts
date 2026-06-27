import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatWorkspace } from '../chat-workspace';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
};

export class ChatImageStorage {
  constructor(private readonly workspace: ChatWorkspace) {}

  save(conversationId: string, data: Buffer, mimeType: string): { ref: string; mimeType: string } {
    const dir = this.workspace.imagesDir(conversationId);
    const ext = EXT_BY_MIME[mimeType] ?? 'png';
    const ref = join(dir, `${randomUUID()}.${ext}`);
    writeFileSync(ref, data);
    return { ref, mimeType };
  }

  /**
   * Copy an existing image file into `conversationId`'s own image folder and
   * return the new absolute ref. Used on fork so a branch owns its images and
   * deleting the parent can't dangle them.
   */
  copyInto(srcRef: string, conversationId: string): string {
    const dir = this.workspace.imagesDir(conversationId);
    const ext = extname(srcRef) || '.png';
    const ref = join(dir, `${randomUUID()}${ext}`);
    try {
      copyFileSync(srcRef, ref);
      return ref;
    } catch {
      // Source already gone/unreadable — keep the original ref rather than fail
      // the whole fork (which would roll back the branch and orphan this dir).
      return srcRef;
    }
  }

  /**
   * Read a stored image back as a base64 data URL. Reference images for edits
   * must be inlined as data URLs — the remote image API cannot read local paths.
   */
  readAsDataUrl(ref: string, mimeType: string): string {
    const b64 = readFileSync(ref).toString('base64');
    return `data:${mimeType};base64,${b64}`;
  }
}
