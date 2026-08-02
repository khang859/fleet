import { describe, it, expect } from 'vitest';
import { applySort } from '../remote-ssh-store';
import type { RemoteDirEntry } from '../../../../shared/remote-ssh-types';

function entry(partial: Partial<RemoteDirEntry> & { name: string }): RemoteDirEntry {
  return {
    path: `/home/${partial.name}`,
    kind: 'file',
    size: 0,
    mtimeMs: 0,
    ...partial
  };
}

const ENTRIES: RemoteDirEntry[] = [
  entry({ name: 'zebra.txt', size: 10, mtimeMs: 3000 }),
  entry({ name: 'src', kind: 'dir', size: 4096, mtimeMs: 1000 }),
  entry({ name: 'Apple.txt', size: 500, mtimeMs: 2000 }),
  entry({ name: 'assets', kind: 'dir', size: 4096, mtimeMs: 5000 })
];

const names = (entries: RemoteDirEntry[]): string[] => entries.map((e) => e.name);

describe('applySort', () => {
  it('puts directories first regardless of sort key', () => {
    for (const key of ['name', 'size', 'modified'] as const) {
      for (const dir of ['asc', 'desc'] as const) {
        const sorted = applySort(ENTRIES, key, dir);
        expect(sorted.slice(0, 2).every((e) => e.kind === 'dir')).toBe(true);
      }
    }
  });

  it('sorts names case-insensitively', () => {
    expect(names(applySort(ENTRIES, 'name', 'asc'))).toEqual([
      'assets',
      'src',
      'Apple.txt',
      'zebra.txt'
    ]);
  });

  it('reverses within each group when descending', () => {
    expect(names(applySort(ENTRIES, 'name', 'desc'))).toEqual([
      'src',
      'assets',
      'zebra.txt',
      'Apple.txt'
    ]);
  });

  it('sorts files by size without disturbing the directory block', () => {
    expect(names(applySort(ENTRIES, 'size', 'asc'))).toEqual([
      'src',
      'assets',
      'zebra.txt',
      'Apple.txt'
    ]);
  });

  it('sorts by modification time', () => {
    expect(names(applySort(ENTRIES, 'modified', 'desc'))).toEqual([
      'assets',
      'src',
      'zebra.txt',
      'Apple.txt'
    ]);
  });

  it('does not mutate its input', () => {
    const original = names(ENTRIES);
    applySort(ENTRIES, 'size', 'desc');
    expect(names(ENTRIES)).toEqual(original);
  });
});
