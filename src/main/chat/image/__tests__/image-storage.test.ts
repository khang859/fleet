import { describe, it, expect, afterEach } from 'vitest';
import { rmSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { ChatImageStorage } from '../image-storage';
import { ChatWorkspace } from '../../chat-workspace';

const CONV_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const CONV_B = 'bbbbbbbb-1111-2222-3333-444444444444';

function setup() {
  const base = join(tmpdir(), `fleet-chat-img-${process.pid}-${Math.floor(performance.now())}`);
  const legacy = join(
    tmpdir(),
    `fleet-chat-img-legacy-${process.pid}-${Math.floor(performance.now())}`
  );
  const workspace = new ChatWorkspace(base, legacy);
  return { base, legacy, workspace, storage: new ChatImageStorage(workspace) };
}

let cleanup: string[] = [];
afterEach(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  cleanup = [];
});

describe('ChatImageStorage', () => {
  it('writes bytes under the conversation image dir and returns a real path', () => {
    const { base, storage } = setup();
    cleanup.push(base);
    const { ref, mimeType } = storage.save(CONV_A, Buffer.from('PNGDATA'), 'image/png');
    expect(existsSync(ref)).toBe(true);
    expect(ref.endsWith('.png')).toBe(true);
    expect(dirname(ref)).toBe(join(base, CONV_A, 'images'));
    expect(mimeType).toBe('image/png');
    expect(readFileSync(ref).toString()).toBe('PNGDATA');
  });

  it('copyInto duplicates a file into another conversation, independent of the source', () => {
    const { base, storage } = setup();
    cleanup.push(base);
    const { ref: srcRef } = storage.save(CONV_A, Buffer.from('ORIGINAL'), 'image/png');
    const newRef = storage.copyInto(srcRef, CONV_B);

    expect(newRef).not.toBe(srcRef);
    expect(dirname(newRef)).toBe(join(base, CONV_B, 'images'));
    expect(readFileSync(newRef).toString()).toBe('ORIGINAL');

    // Deleting the source folder must not affect the copy (the fork-bug guard).
    rmSync(join(base, CONV_A), { recursive: true, force: true });
    expect(existsSync(newRef)).toBe(true);
    expect(readFileSync(newRef).toString()).toBe('ORIGINAL');
  });
});
