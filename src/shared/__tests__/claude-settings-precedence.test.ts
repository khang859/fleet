import { describe, it, expect } from 'vitest';
import {
  classifyKey,
  describePrecedence,
  isIneffectiveDefaultMode,
  resolveEffective,
  SCOPE_PRECEDENCE
} from '../claude-settings-precedence';

describe('classifyKey', () => {
  it('calls the permission lists lists', () => {
    expect(classifyKey(['permissions', 'allow'])).toBe('list');
    expect(classifyKey(['permissions', 'deny'])).toBe('list');
    expect(classifyKey(['permissions', 'additionalDirectories'])).toBe('list');
  });

  it('calls ordinary keys scalar', () => {
    expect(classifyKey(['model'])).toBe('scalar');
    expect(classifyKey(['permissions', 'defaultMode'])).toBe('scalar');
    expect(classifyKey(['env'])).toBe('scalar');
  });

  it('calls the four model keys special, whatever their type', () => {
    expect(classifyKey(['fallbackModel'])).toBe('special');
    expect(classifyKey(['modelPicker'])).toBe('special');
    expect(classifyKey(['availableModels'])).toBe('special');
    expect(classifyKey(['modelSettings'])).toBe('special');
  });

  it('treats an unknown key as scalar rather than guessing', () => {
    expect(classifyKey(['somethingNewInTheNextRelease'])).toBe('scalar');
  });
});

describe('describePrecedence', () => {
  it('reports nothing when no file sets the key', () => {
    expect(describePrecedence(['model'], {})).toEqual({ kind: 'unset' });
    expect(describePrecedence(['model'], { user: {}, project: {} })).toEqual({ kind: 'unset' });
  });

  it('reports a single setter as uncontested', () => {
    expect(describePrecedence(['model'], { user: { model: 'claude-opus-5' } })).toEqual({
      kind: 'only',
      scope: 'user'
    });
  });

  it('gives a scalar to the narrowest file that sets it', () => {
    const result = describePrecedence(['model'], {
      user: { model: 'claude-opus-5' },
      project: { model: 'claude-sonnet-5' },
      projectLocal: { model: 'claude-haiku-4-5-20251001' }
    });
    expect(result).toEqual({
      kind: 'overridden',
      winner: 'projectLocal',
      losers: ['project', 'user']
    });
  });

  it('prefers project over user when there is no local file', () => {
    const result = describePrecedence(['model'], {
      user: { model: 'a' },
      project: { model: 'b' }
    });
    expect(result).toEqual({ kind: 'overridden', winner: 'project', losers: ['user'] });
  });

  it('reports a list as combined, never as overridden', () => {
    const result = describePrecedence(['permissions', 'allow'], {
      user: { permissions: { allow: ['WebSearch'] } },
      projectLocal: { permissions: { allow: ['Bash(npm test:*)'] } }
    });
    expect(result).toEqual({ kind: 'combined', contributors: ['projectLocal', 'user'] });
  });

  it('reports an empty list as a contribution - the key is still set', () => {
    const result = describePrecedence(['permissions', 'deny'], {
      user: { permissions: { deny: [] } },
      project: { permissions: { deny: ['Bash(rm:*)'] } }
    });
    expect(result).toEqual({ kind: 'combined', contributors: ['project', 'user'] });
  });

  it('gives no verdict for a special key', () => {
    const result = describePrecedence(['fallbackModel'], {
      user: { fallbackModel: ['a'] },
      project: { fallbackModel: ['b'] }
    });
    expect(result).toEqual({ kind: 'special', scopes: ['project', 'user'] });
  });

  it('gives no verdict for a special key even when only one file sets it', () => {
    expect(describePrecedence(['modelSettings'], { user: { modelSettings: {} } })).toEqual({
      kind: 'special',
      scopes: ['user']
    });
  });

  it('reads a nested path without tripping over a missing parent', () => {
    const result = describePrecedence(['permissions', 'defaultMode'], {
      user: { permissions: { defaultMode: 'auto' } },
      project: { model: 'x' }
    });
    expect(result).toEqual({ kind: 'only', scope: 'user' });
  });

  it('does not treat an explicit null or false as unset', () => {
    expect(
      describePrecedence(['alwaysThinkingEnabled'], {
        user: { alwaysThinkingEnabled: false }
      })
    ).toEqual({ kind: 'only', scope: 'user' });
  });

  it('does not mistake an array parent for an object while walking', () => {
    expect(describePrecedence(['permissions', 'allow'], { user: { permissions: [] } })).toEqual({
      kind: 'unset'
    });
  });

  it('always reports scopes narrowest first', () => {
    expect(SCOPE_PRECEDENCE).toEqual(['projectLocal', 'project', 'user']);
  });
});

describe('isIneffectiveDefaultMode', () => {
  it('flags auto and bypassPermissions in the project scopes', () => {
    expect(isIneffectiveDefaultMode('project', 'auto')).toBe(true);
    expect(isIneffectiveDefaultMode('projectLocal', 'bypassPermissions')).toBe(true);
  });

  it('allows them in user settings', () => {
    expect(isIneffectiveDefaultMode('user', 'auto')).toBe(false);
    expect(isIneffectiveDefaultMode('user', 'bypassPermissions')).toBe(false);
  });

  it('leaves every other mode alone', () => {
    expect(isIneffectiveDefaultMode('project', 'plan')).toBe(false);
    expect(isIneffectiveDefaultMode('projectLocal', 'acceptEdits')).toBe(false);
  });
});

describe('resolveEffective', () => {
  it('reports nothing when no file sets the key', () => {
    expect(resolveEffective(['model'], {})).toEqual({ kind: 'unset' });
  });

  it('gives a scalar the narrowest file and names the files it beat', () => {
    expect(
      resolveEffective(['model'], {
        user: { model: 'sonnet' },
        project: { model: 'opus' },
        projectLocal: { model: 'haiku' }
      })
    ).toEqual({
      kind: 'replaced',
      value: 'haiku',
      winner: 'projectLocal',
      losers: ['project', 'user']
    });
  });

  it('gives a scalar set once no losers', () => {
    expect(resolveEffective(['model'], { user: { model: 'opus' } })).toEqual({
      kind: 'replaced',
      value: 'opus',
      winner: 'user',
      losers: []
    });
  });

  it('keeps every file entry list, narrowest first', () => {
    expect(
      resolveEffective(['permissions', 'allow'], {
        user: { permissions: { allow: ['Bash(ls:*)'] } },
        projectLocal: { permissions: { allow: ['Read(*)', 'Write(*)'] } }
      })
    ).toEqual({
      kind: 'combined',
      parts: [
        { scope: 'projectLocal', entries: ['Read(*)', 'Write(*)'] },
        { scope: 'user', entries: ['Bash(ls:*)'] }
      ]
    });
  });

  it('reports a list set in one file as combined with one part', () => {
    expect(
      resolveEffective(['permissions', 'deny'], { user: { permissions: { deny: ['Bash(rm:*)'] } } })
    ).toEqual({ kind: 'combined', parts: [{ scope: 'user', entries: ['Bash(rm:*)'] }] });
  });

  it('contributes nothing from a list key holding the wrong type', () => {
    expect(
      resolveEffective(['permissions', 'allow'], { user: { permissions: { allow: 'nope' } } })
    ).toEqual({ kind: 'combined', parts: [{ scope: 'user', entries: [] }] });
  });

  it('refuses to resolve a key whose rule it cannot express', () => {
    expect(resolveEffective(['modelPicker'], { user: { modelPicker: {} } })).toEqual({
      kind: 'special',
      scopes: ['user']
    });
  });
});
