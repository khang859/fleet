import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf'
};

export class ChatImageStorage {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  save(conversationId: string, data: Buffer, mimeType: string): { ref: string; mimeType: string } {
    const dir = join(this.baseDir, conversationId);
    mkdirSync(dir, { recursive: true });
    const ext = EXT_BY_MIME[mimeType] ?? 'png';
    const ref = join(dir, `${randomUUID()}.${ext}`);
    writeFileSync(ref, data);
    return { ref, mimeType };
  }

  /**
   * Read a stored image back as a base64 data URL. Reference images for edits
   * must be inlined as data URLs — the remote image API cannot read local paths.
   */
  readAsDataUrl(ref: string, mimeType: string): string {
    const b64 = readFileSync(ref).toString('base64');
    return `data:${mimeType};base64,${b64}`;
  }

  deleteConversation(conversationId: string): void {
    rmSync(join(this.baseDir, conversationId), { recursive: true, force: true });
  }
}
