import { describe, it, expect } from 'vitest';
import { summarizeChanges, changedKeys, formatList } from '../claude-change-summary';

const json = (value: unknown): string => JSON.stringify(value);

describe('summarizeChanges', () => {
  it('says nothing changed as a plain label when the text is identical', () => {
    expect(summarizeChanges('{}', '{}')).toEqual({
      count: 0,
      sections: [],
      label: 'Unsaved changes'
    });
  });

  it('names one changed setting and its section', () => {
    const summary = summarizeChanges('{}', json({ model: 'opus' }));
    expect(summary.label).toBe('1 unsaved change in Model and behaviour');
  });

  it('counts permission rules one by one rather than as one key', () => {
    const before = json({ permissions: { allow: ['a'], deny: [] } });
    const after = json({ permissions: { allow: ['a', 'b'], deny: ['c'] } });
    expect(summarizeChanges(before, after).label).toBe('2 unsaved changes in Permissions');
  });

  it('separates section names with a middot, since one contains "and"', () => {
    const after = json({ model: 'opus', permissions: { allow: ['a'] } });
    expect(summarizeChanges('{}', after).label).toBe(
      '2 unsaved changes in Model and behaviour \u00b7 Permissions'
    );
  });

  it('lists every section that changed', () => {
    const after = json({ model: 'opus', permissions: { allow: ['a'] }, hooks: { Stop: [] } });
    expect(summarizeChanges('{}', after).sections).toEqual([
      'Model and behaviour',
      'Permissions',
      'Hooks'
    ]);
  });

  it('files an unknown key under Other settings', () => {
    expect(summarizeChanges('{}', json({ somethingNew: 1 })).label).toBe(
      '1 unsaved change in Other settings'
    );
  });

  it('falls back to a plain label when either side does not parse', () => {
    expect(summarizeChanges('{}', '{ broken').label).toBe('Unsaved changes');
  });
});

describe('changedKeys', () => {
  it('returns the top-level keys that differ, sorted', () => {
    const a = json({ model: 'opus', env: { A: '1' } });
    const b = json({ model: 'sonnet', env: { A: '1' }, hooks: {} });
    expect(changedKeys(a, b)).toEqual(['hooks', 'model']);
  });

  it('returns nothing when a side does not parse', () => {
    expect(changedKeys('{ broken', '{}')).toEqual([]);
  });
});

describe('formatList', () => {
  it.each([
    [[], ''],
    [['A'], 'A'],
    [['A', 'B'], 'A and B'],
    [['A', 'B', 'C'], 'A, B and C']
  ])('formats %j', (items, expected) => {
    expect(formatList(items)).toBe(expected);
  });
});
