import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { jsonCaretContext } from '../claude-json-path';

/**
 * The caret marker in each fixture is `|`. It is stripped before the document
 * is built, so the tests read the way the editor looks.
 */
function contextAt(withCaret: string): ReturnType<typeof jsonCaretContext> {
  const pos = withCaret.indexOf('|');
  const doc = withCaret.replace('|', '');
  const state = EditorState.create({ doc, extensions: [json()] });
  return jsonCaretContext(state, pos);
}

describe('jsonCaretContext', () => {
  it('reports a key position at the top level', () => {
    expect(contextAt('{\n  "mod|"\n}')).toEqual({ path: [], at: 'key' });
  });

  it('reports a key position inside a nested object', () => {
    expect(contextAt('{\n  "permissions": {\n    "def|"\n  }\n}')).toEqual({
      path: ['permissions'],
      at: 'key'
    });
  });

  it('reports a value position with the full key path', () => {
    expect(contextAt('{\n  "permissions": {\n    "defaultMode": "pl|"\n  }\n}')).toEqual({
      path: ['permissions', 'defaultMode'],
      at: 'value'
    });
  });

  it('reports a key position in the empty space of an object', () => {
    expect(contextAt('{\n  "permissions": {\n    |\n  }\n}')).toEqual({
      path: ['permissions'],
      at: 'key'
    });
  });

  it('keeps the owning key when the caret is inside an array value', () => {
    expect(contextAt('{\n  "permissions": {\n    "allow": ["Bash(l|)"]\n  }\n}')).toEqual({
      path: ['permissions', 'allow'],
      at: 'value'
    });
  });

  it('reports a top-level value position', () => {
    expect(contextAt('{\n  "model": "op|"\n}')).toEqual({ path: ['model'], at: 'value' });
  });
});
