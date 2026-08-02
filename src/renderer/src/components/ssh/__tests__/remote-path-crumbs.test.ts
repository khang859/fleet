import { describe, it, expect } from 'vitest';
import { toCrumbs } from '../remote-path-crumbs';

describe('toCrumbs', () => {
  it('always starts at the root', () => {
    expect(toCrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  });

  it('accumulates absolute paths for each segment', () => {
    expect(toCrumbs('/home/knguyen/projects')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'knguyen', path: '/home/knguyen' },
      { label: 'projects', path: '/home/knguyen/projects' }
    ]);
  });

  it('ignores a trailing slash rather than emitting an empty crumb', () => {
    expect(toCrumbs('/var/log/')).toEqual(toCrumbs('/var/log'));
  });

  it('collapses repeated separators', () => {
    expect(toCrumbs('//var//log')).toEqual(toCrumbs('/var/log'));
  });

  it('keeps segments containing spaces and dots intact', () => {
    expect(toCrumbs('/home/a b/.config')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'a b', path: '/home/a b' },
      { label: '.config', path: '/home/a b/.config' }
    ]);
  });
});
