import { describe, it, expect } from 'vitest';
import {
  registerEditorHandle,
  unregisterEditorHandle,
  getEditorHandle,
  getEditorHandlesForFile,
  type EditorHandle
} from '../editor-context-registry';

function fakeHandle(): EditorHandle {
  return {
    getSelection: () => ({ fromLine: 1, toLine: 1 }),
    getContent: () => 'x',
    reloadFromDisk: async () => {
      await Promise.resolve();
      return 'x';
    },
    flashLines: () => {},
    writeContent: async () => {},
    save: async () => {},
    getFilePath: () => 'x',
    isClean: () => true
  };
}

describe('editor-context-registry', () => {
  it('registers and retrieves a handle by pane id', () => {
    const h = fakeHandle();
    registerEditorHandle('pane-1', h);
    expect(getEditorHandle('pane-1')).toBe(h);
  });
  it('returns undefined after unregister', () => {
    registerEditorHandle('pane-2', fakeHandle());
    unregisterEditorHandle('pane-2');
    expect(getEditorHandle('pane-2')).toBeUndefined();
  });
  it('finds handles by file path', () => {
    const h = fakeHandle();
    registerEditorHandle('pane-9', h);
    expect(getEditorHandlesForFile('x')).toContain(h);
    expect(getEditorHandlesForFile('nope')).toEqual([]);
    unregisterEditorHandle('pane-9');
  });
});
