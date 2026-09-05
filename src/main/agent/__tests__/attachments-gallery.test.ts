import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageStore from '../image-store';

/**
 * A picture from the gallery, sent into a conversation.
 *
 * The gallery is global, so the picture on offer usually belongs to some other
 * conversation - and that is the whole subject of this file. Deleting a
 * conversation takes its pictures with it, so an attachment that merely pointed
 * at another conversation's file would go blank when that conversation was
 * deleted, in a transcript that has nothing to do with it.
 *
 * `isAgentImagePath` is the gate, and it answers about two folders under the
 * user's home. Stubbing just that one predicate keeps the test off the real home
 * folder while leaving the store, the size ceiling and the copy itself real.
 */
vi.mock('../image-store', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageStore>();
  return { ...actual, isAgentImagePath: (path: string) => path.includes('fleet-gallery-source') };
});

vi.mock('../pdf/parse', () => ({
  parsePdf: async () => Promise.resolve({ text: '', pages: 1, scanned: true })
}));

const { resolveAttachment } = await import('../attachments');
const { AgentImageStore } = await import('../image-store');

const THREAD = '11111111-2222-4333-8444-555555555555';

let cwd: string;
let source: string;
let storeRoot: string;
let store: InstanceType<typeof AgentImageStore>;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'fleet-gallery-cwd-'));
  source = mkdtempSync(join(tmpdir(), 'fleet-gallery-source-'));
  storeRoot = mkdtempSync(join(tmpdir(), 'fleet-gallery-store-'));
  store = new AgentImageStore(storeRoot);
});

afterEach(() => {
  for (const dir of [cwd, source, storeRoot]) rmSync(dir, { recursive: true, force: true });
});

function generated(name: string, contents = 'png bytes'): string {
  const dir = join(source, 'images', THREAD);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

const attach = async (path: string) =>
  resolveAttachment({ threadId: THREAD, cwd, source: { kind: 'path', path } }, store);

describe('attaching a picture from the gallery', () => {
  it('takes a copy, so deleting the conversation that made it leaves this one whole', async () => {
    const path = generated('a.png');

    const result = await attach(path);

    expect(result.ok).toBe(true);
    if (!result.ok || result.attachment.kind !== 'image') throw new Error('not an image');
    // Under the receiving conversation, not the one that generated it.
    expect(result.attachment.path.startsWith(join(storeRoot, THREAD))).toBe(true);
    expect(result.attachment.mimeType).toBe('image/png');
    expect(readFileSync(result.attachment.path).toString()).toBe('png bytes');

    // The picture survives the source conversation being deleted, which is the
    // whole point of the copy.
    rmSync(join(source, 'images', THREAD), { recursive: true, force: true });
    expect(readFileSync(result.attachment.path).toString()).toBe('png bytes');
  });

  it('refuses one past the ceiling rather than copying it', async () => {
    const path = generated('huge.png', 'x'.repeat(8_000_001));

    expect(await attach(path)).toEqual({
      ok: false,
      error: expect.stringContaining('too large')
    });
    expect(readdirSync(storeRoot)).toHaveLength(0);
  });

  it('still refuses a file that is outside the folder and not one of ours', async () => {
    const path = join(cwd, '..', 'nowhere.png');
    expect((await attach(path)).ok).toBe(false);
  });
});
