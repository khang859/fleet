import { describe, it, expect } from 'vitest';
import { join } from 'path';

describe('FILE_READDIR handler logic', () => {
  it('sorts directories before files, then alphabetically', () => {
    type Entry = { name: string; isFile: () => boolean; isDirectory: () => boolean };
    const raw: Entry[] = [
      { name: 'zoo.ts', isFile: () => true, isDirectory: () => false },
      { name: 'alpha', isFile: () => false, isDirectory: () => true },
      { name: 'beta.ts', isFile: () => true, isDirectory: () => false },
      { name: 'mango', isFile: () => false, isDirectory: () => true }
    ];

    const sorted = raw
      .filter((e) => e.isFile() || e.isDirectory())
      .sort((a, b) => {
        const aIsDir = a.isDirectory();
        const bIsDir = b.isDirectory();
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    expect(sorted.map((e) => e.name)).toEqual(['alpha', 'mango', 'beta.ts', 'zoo.ts']);
  });

  it('maps entries to the correct shape', () => {
    type Entry = { name: string; isFile: () => boolean; isDirectory: () => boolean };
    const entries: Entry[] = [
      { name: 'src', isFile: () => false, isDirectory: () => true }
    ];
    const dirPath = '/home/user/project';
    const result = entries.map((e) => ({
      name: e.name,
      path: join(dirPath, e.name),
      isDirectory: e.isDirectory()
    }));
    expect(result[0]).toEqual({ name: 'src', path: '/home/user/project/src', isDirectory: true });
  });
});
