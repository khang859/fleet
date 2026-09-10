import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { claudeSettingsDiagnostics } from '../claude-settings-lint';

const blocks = (diagnostics: ReturnType<typeof claudeSettingsDiagnostics>): boolean =>
  diagnostics.some((d) => d.severity === 'error');
import { isKnownTopLevelKey } from '../../../../shared/claude-settings-schema';

function lint(doc: string): ReturnType<typeof claudeSettingsDiagnostics> {
  const state = EditorState.create({ doc, extensions: [json()] });
  return claudeSettingsDiagnostics(state, isKnownTopLevelKey);
}

describe('claudeSettingsDiagnostics', () => {
  it('reports broken JSON as an error that blocks the save', () => {
    const diagnostics = lint('{ "model": }');
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(blocks(diagnostics)).toBe(true);
  });

  it('accepts a valid file with nothing to say', () => {
    expect(lint('{\n  "model": "opus"\n}')).toEqual([]);
  });

  it('reports an unknown key as a warning that does not block the save', () => {
    const diagnostics = lint('{\n  "totallyFakeKey": 1\n}');
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].message).toContain('totallyFakeKey');
    expect(blocks(diagnostics)).toBe(false);
  });

  it('points the unknown-key warning at the key itself, not at the file start', () => {
    const doc = '{\n  "model": "opus",\n  "totallyFakeKey": 1\n}';
    const diagnostics = lint(doc);
    expect(diagnostics[0].from).toBe(doc.indexOf('"totallyFakeKey"'));
  });

  it('warns about a wrong-typed value without blocking the save', () => {
    const diagnostics = lint('{\n  "cleanupPeriodDays": "thirty"\n}');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });

  it('warns about a value outside an enum', () => {
    const diagnostics = lint('{\n  "effortLevel": "nuclear"\n}');
    expect(diagnostics.some((d) => d.message.includes('effortLevel'))).toBe(true);
    expect(blocks(diagnostics)).toBe(false);
  });

  it('rejects a document that is not an object', () => {
    expect(blocks(lint('[1, 2]'))).toBe(true);
  });

  it('says nothing about a hooks block, which the page never writes', () => {
    const doc = '{\n  "hooks": {\n    "Stop": []\n  }\n}';
    expect(lint(doc)).toEqual([]);
  });
});
