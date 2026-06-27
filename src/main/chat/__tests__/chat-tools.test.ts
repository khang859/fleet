import { describe, it, expect, vi } from 'vitest';
import { parseGenerateImageArgs, runGenerateImage } from '../chat-tools';
import type { ChatImageProvider } from '../image/types';
import { ChatImageStorage } from '../image/image-storage';
import { ChatWorkspace } from '../chat-workspace';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('chat-tools', () => {
  it('parses args and defaults edit to false', () => {
    expect(parseGenerateImageArgs('{"prompt":"a fox"}')).toEqual({ prompt: 'a fox', edit: false });
    expect(parseGenerateImageArgs('{"prompt":"x","edit":true}')).toEqual({
      prompt: 'x',
      edit: true
    });
  });

  it('throws on missing prompt', () => {
    expect(() => parseGenerateImageArgs('{}')).toThrow();
  });

  it('runs the provider and saves the image, returning a generated ref', async () => {
    const base = join(tmpdir(), `fleet-tools-${process.pid}`);
    mkdirSync(base, { recursive: true });
    /* eslint-disable @typescript-eslint/require-await */
    const provider: ChatImageProvider = {
      id: 'openrouter',
      generate: vi.fn(async () => ({ data: Buffer.from('IMG'), mimeType: 'image/png' }))
    };
    /* eslint-enable @typescript-eslint/require-await */
    const storage = new ChatImageStorage(new ChatWorkspace(base, `${base}-legacy`));
    const ref = await runGenerateImage(
      { provider, storage },
      { conversationId: 'c1', prompt: 'a fox', model: 'm', signal: new AbortController().signal }
    );
    expect(ref.kind).toBe('generated');
    expect(ref.mimeType).toBe('image/png');
    expect(ref.ref).toContain('c1');
    rmSync(base, { recursive: true, force: true });
  });
});
