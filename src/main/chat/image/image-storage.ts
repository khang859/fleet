import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
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

  deleteConversation(conversationId: string): void {
    rmSync(join(this.baseDir, conversationId), { recursive: true, force: true });
  }
}
