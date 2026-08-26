import { describe, it, expect } from 'vitest';
import type { Tab } from '../../../../shared/types';
import {
  buildTabNesting,
  insertNestedTab,
  nestedBlockLength,
  nestInsertIndex,
  resolveFileParentId
} from '../tab-nesting';

function session(id: string, cwd: string, extra: Partial<Tab> = {}): Tab {
  return {
    id,
    label: id,
    labelIsCustom: false,
    cwd,
    splitRoot: { type: 'leaf', id: `pane-${id}`, cwd },
    ...extra
  };
}

function fileTab(id: string, filePath: string, parentTabId?: string): Tab {
  return {
    id,
    label: id,
    labelIsCustom: true,
    cwd: '/',
    type: 'file',
    splitRoot: { type: 'leaf', id: `pane-${id}`, cwd: '/', paneType: 'file', filePath },
    ...(parentTabId ? { parentTabId } : {})
  };
}

const cwdOf = (tab: Tab): string => tab.cwd;

describe('resolveFileParentId', () => {
  it('picks the session the user was looking at', () => {
    const tabs = [session('s1', '/a'), session('s2', '/b')];
    expect(resolveFileParentId(tabs, 's2', '/a/x.ts', cwdOf)).toBe('s2');
  });

  it('hops through a nested file to the session it belongs to', () => {
    const tabs = [session('s1', '/a'), fileTab('f1', '/a/x.ts', 's1')];
    expect(resolveFileParentId(tabs, 'f1', '/a/y.ts', cwdOf)).toBe('s1');
  });

  it('falls back to the deepest session containing the file', () => {
    const tabs = [session('s1', '/a'), session('s2', '/a/b'), session('s3', '/c')];
    expect(resolveFileParentId(tabs, null, '/a/b/x.ts', cwdOf)).toBe('s2');
  });

  it('leaves a file parentless when nothing is focused and no cwd matches', () => {
    const tabs = [session('s1', '/a')];
    expect(resolveFileParentId(tabs, null, '/elsewhere/x.ts', cwdOf)).toBeUndefined();
  });

  it('never parents onto a non-session tab', () => {
    const tabs = [{ ...session('agent', '/a'), type: 'agent' as const }, fileTab('f1', '/a/x.ts')];
    expect(resolveFileParentId(tabs, 'agent', '/a/x.ts', cwdOf)).toBeUndefined();
    expect(resolveFileParentId(tabs, 'f1', '/a/x.ts', cwdOf)).toBeUndefined();
  });

  it('matches whole path segments, not string prefixes', () => {
    const tabs = [session('s1', '/a/proj'), session('s2', '/a/proj-other')];
    expect(resolveFileParentId(tabs, null, '/a/proj-other/x.ts', cwdOf)).toBe('s2');
  });

  it('ignores case and separators on win32', () => {
    const tabs = [session('s1', 'C:\\Users\\K\\Proj', { pathContext: 'win32' })];
    expect(resolveFileParentId(tabs, null, 'c:/users/k/proj/x.ts', cwdOf)).toBe('s1');
  });
});

describe('buildTabNesting', () => {
  it('groups files under their session and marks them as nested', () => {
    const tabs = [
      session('s1', '/a'),
      fileTab('f2', '/a/y.ts', 's1'),
      fileTab('f1', '/a/x.ts', 's1')
    ];
    const { childrenByParent, nestedIds } = buildTabNesting(tabs);
    expect(childrenByParent.get('s1')?.map((t) => t.id)).toEqual(['f2', 'f1']);
    expect([...nestedIds]).toEqual(['f2', 'f1']);
  });

  it('promotes a file whose session is gone', () => {
    const tabs = [fileTab('f1', '/a/x.ts', 'closed-session')];
    const { childrenByParent, nestedIds } = buildTabNesting(tabs);
    expect(childrenByParent.size).toBe(0);
    expect(nestedIds.size).toBe(0);
  });
});

describe('nestedBlockLength', () => {
  const tabs = [
    session('s1', '/a'),
    fileTab('f1', '/a/x.ts', 's1'),
    fileTab('f2', '/a/y.ts', 's1'),
    session('s2', '/b')
  ];

  it('counts a session plus the run of its files', () => {
    expect(nestedBlockLength(tabs, 0)).toBe(2 + 1);
  });

  it('moves a file on its own', () => {
    expect(nestedBlockLength(tabs, 1)).toBe(1);
  });

  it('stops at a file belonging to another session', () => {
    const mixed = [session('s1', '/a'), fileTab('f1', '/b/x.ts', 's2'), session('s2', '/b')];
    expect(nestedBlockLength(mixed, 0)).toBe(1);
  });
});

describe('insertNestedTab', () => {
  it('puts a new file directly under its session', () => {
    const tabs = [session('s1', '/a'), fileTab('f1', '/a/x.ts', 's1'), session('s2', '/b')];
    const next = insertNestedTab(tabs, fileTab('f2', '/a/y.ts', 's1'), 's1');
    expect(next.map((t) => t.id)).toEqual(['s1', 'f2', 'f1', 's2']);
  });

  it('appends a parentless file', () => {
    const tabs = [session('s1', '/a')];
    const next = insertNestedTab(tabs, fileTab('f1', '/z/x.ts'), undefined);
    expect(next.map((t) => t.id)).toEqual(['s1', 'f1']);
  });
});

describe('nestInsertIndex', () => {
  const tabs = [
    session('s1', '/a'),
    fileTab('f1', '/a/x.ts', 's1'),
    fileTab('f2', '/a/y.ts', 's1'),
    session('s2', '/b')
  ];

  it('pushes a drop aimed into a nest past the whole nest', () => {
    expect(nestInsertIndex(tabs, 1)).toBe(3);
    expect(nestInsertIndex(tabs, 2)).toBe(3);
  });

  it('leaves a drop between sessions alone', () => {
    expect(nestInsertIndex(tabs, 0)).toBe(0);
    expect(nestInsertIndex(tabs, 3)).toBe(3);
    expect(nestInsertIndex(tabs, 4)).toBe(4);
  });
});
