import { describe, expect, it } from 'vitest';
import { crumbTrail, parentDir } from '../folder-crumbs';

const HOME = '/Users/ada';

describe('parentDir', () => {
  it('climbs one level at a time', () => {
    expect(parentDir('/Users/ada/Development/fleet')).toBe('/Users/ada/Development');
    expect(parentDir('/Users/ada/Development/fleet/')).toBe('/Users/ada/Development');
    expect(parentDir('/Users')).toBe('/');
  });

  it('stops at a root rather than climbing past it', () => {
    expect(parentDir('/')).toBeNull();
    expect(parentDir('C:\\')).toBeNull();
  });

  it('spells a drive root with its separator, since a bare `C:` is not a folder', () => {
    expect(parentDir('C:\\Users\\ada')).toBe('C:\\Users');
    expect(parentDir('C:\\Users')).toBe('C:\\');
  });
});

describe('crumbTrail', () => {
  it('roots a trail inside home at `~`, not at the full home path', () => {
    expect(crumbTrail('/Users/ada/Development/fleet', HOME)).toEqual([
      { label: '~', path: '/Users/ada' },
      { label: 'Development', path: '/Users/ada/Development' },
      { label: 'fleet', path: '/Users/ada/Development/fleet' }
    ]);
  });

  it('is just the root when the folder is home itself', () => {
    expect(crumbTrail(HOME, HOME)).toEqual([{ label: '~', path: '/Users/ada' }]);
    expect(crumbTrail('/', HOME)).toEqual([{ label: '/', path: '/' }]);
  });

  it('roots a trail outside home at the filesystem root', () => {
    expect(crumbTrail('/usr/local', HOME)).toEqual([
      { label: '/', path: '/' },
      { label: 'usr', path: '/usr' },
      { label: 'local', path: '/usr/local' }
    ]);
  });

  it('does not mistake a sibling that merely starts like home for a folder in it', () => {
    expect(crumbTrail('/Users/adamant', HOME)).toEqual([
      { label: '/', path: '/' },
      { label: 'Users', path: '/Users' },
      { label: 'adamant', path: '/Users/adamant' }
    ]);
  });

  it('keeps a windows trail spelled in windows paths', () => {
    expect(crumbTrail('C:\\Users\\ada\\code', 'C:\\Users\\ada')).toEqual([
      { label: '~', path: 'C:\\Users\\ada' },
      { label: 'code', path: 'C:\\Users\\ada\\code' }
    ]);
    expect(crumbTrail('C:\\tools', 'C:\\Users\\ada')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'tools', path: 'C:\\tools' }
    ]);
  });

  it('ignores trailing separators on either argument', () => {
    expect(crumbTrail('/Users/ada/Development/', '/Users/ada/')).toEqual([
      { label: '~', path: '/Users/ada' },
      { label: 'Development', path: '/Users/ada/Development' }
    ]);
  });

  it('every crumb navigates to a real ancestor of the folder shown', () => {
    const dir = '/Users/ada/a/b/c';
    const trail = crumbTrail(dir, HOME);
    expect(trail.at(-1)?.path).toBe(dir);
    // Walking the trail backwards is the same as walking up with parentDir.
    for (let i = trail.length - 1; i > 0; i--) {
      expect(parentDir(trail[i].path)).toBe(trail[i - 1].path);
    }
  });
});
