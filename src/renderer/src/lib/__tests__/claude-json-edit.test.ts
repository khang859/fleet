import { describe, it, expect } from 'vitest';
import {
  parseSettings,
  serializeSettings,
  valueAtPath,
  recordAtPath,
  setKeyAtPath,
  deleteKeyAtPath,
  applySettingsEdit
} from '../claude-json-edit';

/**
 * A file that carries everything the form does not model: a hooks block, a
 * `statusLine` object, and keys newer than the vendored schema. None of it may
 * move or disappear when one control is changed.
 */
const FIXTURE = `{
  "model": "opus",
  "hooks": {
    "Stop": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "fleet-hook" }] }]
  },
  "statusLine": { "type": "command", "command": "my-status" },
  "permissions": { "allow": ["Bash(ls:*)"], "defaultMode": "plan" },
  "totallyFakeKey": 1,
  "anotherNewKey": ["a", "b"],
  "thirdNewKey": { "nested": true }
}
`;

describe('applySettingsEdit', () => {
  it('changes only the edited key and keeps every other key deeply equal', () => {
    const next = applySettingsEdit(FIXTURE, ['model'], 'sonnet');
    expect(next).not.toBeNull();

    const before = parseSettings(FIXTURE);
    const after = parseSettings(next as string);
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();

    for (const key of Object.keys(before as Record<string, unknown>)) {
      if (key === 'model') continue;
      expect((after as Record<string, unknown>)[key]).toEqual(
        (before as Record<string, unknown>)[key]
      );
    }
    expect((after as Record<string, unknown>).model).toBe('sonnet');
  });

  it('keeps the keys in the same relative order', () => {
    const next = applySettingsEdit(FIXTURE, ['permissions', 'defaultMode'], 'acceptEdits');
    expect(Object.keys(parseSettings(next as string) as Record<string, unknown>)).toEqual(
      Object.keys(parseSettings(FIXTURE) as Record<string, unknown>)
    );
  });

  it('removes the key when the value is undefined, rather than writing null', () => {
    const next = applySettingsEdit(FIXTURE, ['model'], undefined) as string;
    const after = parseSettings(next) as Record<string, unknown>;
    expect('model' in after).toBe(false);
    expect(next).not.toContain('null');
  });

  it('creates a missing parent object on the way to a nested key', () => {
    const next = applySettingsEdit('{}', ['permissions', 'defaultMode'], 'plan') as string;
    expect(parseSettings(next)).toEqual({ permissions: { defaultMode: 'plan' } });
  });

  it('leaves an intermediate object in place when its last key is removed', () => {
    const next = applySettingsEdit(
      '{"permissions":{"defaultMode":"plan"}}',
      ['permissions', 'defaultMode'],
      undefined
    ) as string;
    expect(parseSettings(next)).toEqual({ permissions: {} });
  });

  it('writes two-space indent and a trailing newline', () => {
    const next = applySettingsEdit('{"a":1}', ['a'], 2) as string;
    expect(next).toBe('{\n  "a": 2\n}\n');
  });

  it('returns null for text that does not parse, so the caller can refuse', () => {
    expect(applySettingsEdit('{ oops', ['model'], 'x')).toBeNull();
  });

  it('treats empty text as an empty document', () => {
    expect(applySettingsEdit('   ', ['model'], 'opus')).toBe('{\n  "model": "opus"\n}\n');
  });
});

describe('helpers', () => {
  it('reads a nested value and stops at a non-object', () => {
    const doc = { a: { b: 1 }, c: 2 };
    expect(valueAtPath(doc, ['a', 'b'])).toBe(1);
    expect(valueAtPath(doc, ['c', 'b'])).toBeUndefined();
  });

  it('gives an empty object for a missing or non-object record', () => {
    expect(recordAtPath({ a: 1 }, ['a'])).toEqual({});
    expect(recordAtPath({}, ['env'])).toEqual({});
    expect(recordAtPath({ env: { X: '1' } }, ['env'])).toEqual({ X: '1' });
  });

  it('does not mutate the document it is given', () => {
    const doc = { a: { b: 1 } };
    setKeyAtPath(doc, ['a', 'b'], 2);
    deleteKeyAtPath(doc, ['a', 'b']);
    expect(doc).toEqual({ a: { b: 1 } });
  });

  it('refuses to descend through a non-object when deleting', () => {
    const doc = { a: 1 };
    expect(deleteKeyAtPath(doc, ['a', 'b'])).toBe(doc);
  });

  it('rejects a document that is not a JSON object', () => {
    expect(parseSettings('[1,2]')).toBeNull();
    expect(serializeSettings({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
