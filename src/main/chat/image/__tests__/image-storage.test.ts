import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ChatImageStorage } from '../image-storage';

describe('ChatImageStorage', () => {
  it('writes bytes under the conversation dir and returns a real path', () => {
    const base = join(tmpdir(), `fleet-chat-img-store-${process.pid}`);
    mkdirSync(base, { recursive: true });
    const storage = new ChatImageStorage(base);
    const { ref, mimeType } = storage.save('conv1', Buffer.from('PNGDATA'), 'image/png');
    expect(existsSync(ref)).toBe(true);
    expect(ref.endsWith('.png')).toBe(true);
    expect(mimeType).toBe('image/png');
    expect(readFileSync(ref).toString()).toBe('PNGDATA');

    storage.deleteConversation('conv1');
    expect(existsSync(ref)).toBe(false);
    rmSync(base, { recursive: true, force: true });
  });
});
