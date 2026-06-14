import { describe, it, expect } from 'vitest';
import {
  registerEditorHandle,
  unregisterEditorHandle,
  getEditorHandle,
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
    save: async () => {}
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
});
