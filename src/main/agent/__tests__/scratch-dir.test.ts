import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureScratchSessionDir } from '../scratch-dir';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-scratch-test-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

describe('scratch folders', () => {
  it('isolates new chats and preserves files when reopening a chat', () => {
    const first = ensureScratchSessionDir(FIRST, null, root);
    writeFileSync(join(first, 'notes.txt'), 'keep me');
    const second = ensureScratchSessionDir(SECOND, null, root);
    expect(second).not.toBe(first);
    expect(existsSync(second)).toBe(true);
    expect(existsSync(join(second, 'notes.txt'))).toBe(false);
    expect(ensureScratchSessionDir(FIRST, first, root)).toBe(first);
    expect(readFileSync(join(first, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(ensureScratchSessionDir(FIRST, null, root)).toBe(first);
  });

  it('keeps legacy chats in their original shared folder', () => {
    writeFileSync(join(root, 'old.txt'), 'legacy');
    expect(ensureScratchSessionDir(FIRST, root, root)).toBe(root);
    expect(readFileSync(join(root, 'old.txt'), 'utf8')).toBe('legacy');
  });

  it('rejects an id that could escape the scratch root', () => {
    expect(() => ensureScratchSessionDir('../outside', null, root)).toThrow();
  });
});
