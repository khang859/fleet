import { describe, it, expect } from 'vitest';
import {
  schemaForPath,
  topLevelKeys,
  keysAtPath,
  enumAtPath,
  descriptionAtPath,
  isListKey,
  itemsAtPath,
  isKnownTopLevelKey
} from '../claude-settings-schema';

describe('topLevelKeys', () => {
  it('reads the whole documented key space from the vendored schema', () => {
    const keys = topLevelKeys();
    expect(keys.length).toBeGreaterThan(100);
    expect(keys).toContain('permissions');
    expect(keys).toContain('hooks');
    expect(keys).toContain('statusLine');
  });

  it('is sorted', () => {
    const keys = topLevelKeys();
    expect(keys).toEqual([...keys].sort());
  });
});

describe('schemaForPath', () => {
  it('finds a nested key', () => {
    expect(schemaForPath(['permissions', 'defaultMode'])?.type).toBe('string');
  });

  it('returns undefined for a key the schema does not describe', () => {
    expect(schemaForPath(['nope'])).toBeUndefined();
    expect(schemaForPath(['permissions', 'nope'])).toBeUndefined();
  });

  it('leaves a child $ref alone - only the addressed node is resolved', () => {
    // A caller reaching into `.items` gets the raw reference; `itemsAtPath` is
    // the helper that follows it.
    expect(schemaForPath(['permissions', 'allow'])?.items?.$ref).toBe('#/$defs/permissionRule');
  });
});

describe('itemsAtPath', () => {
  it('follows a $ref to the element definition', () => {
    const items = itemsAtPath(['permissions', 'allow']);
    expect(items).toBeDefined();
    expect(items?.$ref).toBeUndefined();
    expect(items?.type).toBe('string');
  });

  it('returns undefined for a key that is not a list', () => {
    expect(itemsAtPath(['model'])).toBeUndefined();
  });
});

describe('enumAtPath', () => {
  it('returns the permission mode values, including auto', () => {
    const values = enumAtPath(['permissions', 'defaultMode']);
    expect(values).toContain('auto');
    expect(values).toContain('plan');
    expect(values).toContain('bypassPermissions');
  });

  it('returns the effort levels', () => {
    expect(enumAtPath(['effortLevel'])).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('returns nothing for a free-form string key', () => {
    expect(enumAtPath(['model'])).toEqual([]);
  });
});

describe('descriptionAtPath', () => {
  it('carries the documented description for a key', () => {
    expect(descriptionAtPath(['model'])).toContain('model');
  });

  it('returns undefined for an unknown key', () => {
    expect(descriptionAtPath(['nope'])).toBeUndefined();
  });
});

describe('isListKey', () => {
  it('is true for the permission lists', () => {
    expect(isListKey(['permissions', 'allow'])).toBe(true);
    expect(isListKey(['permissions', 'deny'])).toBe(true);
    expect(isListKey(['permissions', 'additionalDirectories'])).toBe(true);
  });

  it('is false for scalars and objects', () => {
    expect(isListKey(['model'])).toBe(false);
    expect(isListKey(['permissions', 'defaultMode'])).toBe(false);
    expect(isListKey(['env'])).toBe(false);
  });

  it('is false for an unknown key', () => {
    expect(isListKey(['nope'])).toBe(false);
  });
});

describe('keysAtPath', () => {
  it('lists the members of a nested object', () => {
    const keys = keysAtPath(['permissions']);
    expect(keys).toContain('allow');
    expect(keys).toContain('deny');
    expect(keys).toContain('defaultMode');
  });

  it('lists the top level for an empty path', () => {
    expect(keysAtPath([])).toEqual(topLevelKeys());
  });
});

describe('isKnownTopLevelKey', () => {
  it('separates documented keys from typos', () => {
    expect(isKnownTopLevelKey('model')).toBe(true);
    expect(isKnownTopLevelKey('modle')).toBe(false);
  });
});
