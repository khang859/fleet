import { describe, it, expect } from 'vitest';
import type { Dirent } from 'fs';
import { sortAndMapDirEntries } from '../ipc-handlers';

function makeDirent(name: string, isDir: boolean, isFile = !isDir): Dirent {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => isFile,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    path: '',
    parentPath: ''
  } as Dirent;
}

describe('sortAndMapDirEntries', () => {
  it('sorts directories before files, both groups alphabetical', () => {
    const entries = [
      makeDirent('zoo.ts', false),
      makeDirent('alpha', true),
      makeDirent('beta.ts', false),
      makeDirent('mango', true)
    ];
    const result = sortAndMapDirEntries(entries, '/root');
    expect(result.map((e) => e.name)).toEqual(['alpha', 'mango', 'beta.ts', 'zoo.ts']);
  });

  it('excludes symlinks (isFile and isDirectory both false)', () => {
    const entries = [makeDirent('link', false, false), makeDirent('real.ts', false, true)];
    const result = sortAndMapDirEntries(entries, '/root');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('real.ts');
  });

  it('maps entries to correct shape with absolute path', () => {
    const entries = [makeDirent('src', true)];
    const result = sortAndMapDirEntries(entries, '/home/user/project');
    expect(result[0]).toEqual({
      name: 'src',
      path: '/home/user/project/src',
      isDirectory: true
    });
  });

  it('returns empty array for empty input', () => {
    expect(sortAndMapDirEntries([], '/any/path')).toEqual([]);
  });
});
