import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentImageStore } from '../image-store';

const THREAD = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-8888-4777-8666-555555555555';

let root: string;
let store: AgentImageStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-images-'));
  store = new AgentImageStore(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('AgentImageStore', () => {
  it('writes an image under its own conversation', () => {
    const path = store.save(THREAD, Buffer.from('png bytes'), 'image/png');
    expect(path.startsWith(join(root, THREAD))).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(readFileSync(path).toString()).toBe('png bytes');
  });

  it('names the file for what it is', () => {
    expect(store.save(THREAD, Buffer.from('x'), 'image/webp').endsWith('.webp')).toBe(true);
    // An unknown type is still an image; png is the honest guess and the one
    // every provider here actually returns.
    expect(store.save(THREAD, Buffer.from('x'), 'image/heic').endsWith('.png')).toBe(true);
  });

  it('never lets a thread id become a path', () => {
    expect(() => store.save('../../escape', Buffer.from('x'), 'image/png')).toThrow(
      'cannot hold images'
    );
    expect(existsSync(join(root, '..', 'escape'))).toBe(false);
  });

  it('takes a conversation’s images with it, and leaves everyone else’s', () => {
    const mine = store.save(THREAD, Buffer.from('x'), 'image/png');
    const theirs = store.save(OTHER, Buffer.from('x'), 'image/png');

    store.remove(THREAD);

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(theirs)).toBe(true);
  });

  it('removing a conversation that never made an image is not an error', () => {
    expect(() => store.remove(OTHER)).not.toThrow();
    expect(() => store.remove('not-a-uuid')).not.toThrow();
  });

  it('recognises its own files, and nothing else', () => {
    const path = store.save(THREAD, Buffer.from('x'), 'image/png');
    expect(store.contains(path)).toBe(true);
    // The one that matters: this is what decides whether a reference may be
    // read from outside the working folder.
    expect(store.contains(join(root, '..', 'somewhere', 'secret.png'))).toBe(false);
    expect(store.contains('/etc/passwd')).toBe(false);
    expect(store.contains(root)).toBe(false);
  });
});
