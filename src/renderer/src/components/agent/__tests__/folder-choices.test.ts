import { describe, expect, it } from 'vitest';
import { folderChoices } from '../folder-choices';
import { scratchDir } from '../../../lib/scratch';

const base = { openFolders: [], recentFolders: [], current: '/elsewhere', filter: '' };

describe('folderChoices', () => {
  it('lists open folders before recent ones, each once', () => {
    const rows = folderChoices({
      ...base,
      openFolders: ['/dev/fleet', '/dev/unmail', '/dev/fleet/'],
      recentFolders: ['/dev/unmail', '/dev/site']
    });

    expect(rows).toEqual([
      { path: '/dev/fleet', name: 'fleet', group: 'open' },
      { path: '/dev/unmail', name: 'unmail', group: 'open' },
      { path: '/dev/site', name: 'site', group: 'recent' }
    ]);
  });

  it('leaves out the folder the pane is already in', () => {
    const rows = folderChoices({
      ...base,
      current: '/dev/fleet',
      openFolders: ['/dev/fleet', '/dev/a']
    });
    expect(rows.map((r) => r.path)).toEqual(['/dev/a']);
  });

  // Scratch has its own row; a scratch tab's folder is not a project.
  it('leaves out scratch folders', () => {
    const rows = folderChoices({
      ...base,
      openFolders: [scratchDir(), `${scratchDir()}/abc`, '/dev/a']
    });
    expect(rows.map((r) => r.path)).toEqual(['/dev/a']);
  });

  it('matches the filter against the name or the whole path', () => {
    const rows = folderChoices({
      ...base,
      openFolders: ['/dev/fleet', '/work/api'],
      recentFolders: ['/dev/flow'],
      filter: 'fl'
    });
    expect(rows.map((r) => r.path)).toEqual(['/dev/fleet', '/dev/flow']);
    expect(folderChoices({ ...base, openFolders: ['/work/api'], filter: 'work' })).toHaveLength(1);
  });

  it('keeps the recent list short', () => {
    const recentFolders = ['/r/1', '/r/2', '/r/3', '/r/4', '/r/5', '/r/6', '/r/7'];
    expect(folderChoices({ ...base, recentFolders })).toHaveLength(5);
  });
});

describe('folderChoices - cap', () => {
  it('lists at most ten folders, so none hide behind a scrollbar', () => {
    const openFolders = Array.from({ length: 12 }, (_, i) => `/open/${i}`);
    expect(folderChoices({ ...base, openFolders, recentFolders: ['/r/1'] })).toHaveLength(10);
  });
});
