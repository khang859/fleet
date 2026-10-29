import { describe, it, expect } from 'vitest';
import { dirCrumbs, parentDir, sortDirEntries } from '../use-browse-dir';

const HOME = '/Users/me';

describe('dirCrumbs', () => {
  it('collapses the home directory to ~ and gives each crumb its full path', () => {
    expect(dirCrumbs(`${HOME}/dev/fleet`, HOME)).toEqual([
      { label: '~', path: HOME },
      { label: 'dev', path: `${HOME}/dev` },
      { label: 'fleet', path: `${HOME}/dev/fleet` }
    ]);
  });

  it('keeps the leading slash for paths outside home', () => {
    expect(dirCrumbs('/tmp/logs', HOME)).toEqual([
      { label: 'tmp', path: '/tmp' },
      { label: 'logs', path: '/tmp/logs' }
    ]);
  });

  it('does not treat a sibling with the same prefix as home', () => {
    expect(dirCrumbs('/Users/meg', HOME)).toEqual([
      { label: 'Users', path: '/Users' },
      { label: 'meg', path: '/Users/meg' }
    ]);
  });

  it('is a single ~ crumb at home itself', () => {
    expect(dirCrumbs(HOME, HOME)).toEqual([{ label: '~', path: HOME }]);
  });
});

describe('parentDir', () => {
  it('drops the last segment', () => {
    expect(parentDir('/a/b/c')).toBe('/a/b');
  });

  it('stops at the root', () => {
    expect(parentDir('/a')).toBe('/');
    expect(parentDir('/')).toBe('/');
  });
});

describe('sortDirEntries', () => {
  it('puts directories first, then sorts by name', () => {
    const entries = [
      { name: 'b.ts', path: '/b.ts', isDirectory: false },
      { name: 'src', path: '/src', isDirectory: true },
      { name: 'a.ts', path: '/a.ts', isDirectory: false },
      { name: 'docs', path: '/docs', isDirectory: true }
    ];

    expect(sortDirEntries(entries).map((e) => e.name)).toEqual(['docs', 'src', 'a.ts', 'b.ts']);
  });
});
