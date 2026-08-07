import { describe, expect, it } from 'vitest';
import {
  diffLineKind,
  diffLines,
  diffStats,
  formatUnified,
  splitLines,
  toHunks
} from '../agent-diff';

/**
 * The diff is what an edit reports to the model and shows the user, so it is
 * held to both standards: the line numbers have to be the file's real ones, and
 * anything it leaves out has to say so.
 */

const numbered = (from: number, to: number): string =>
  Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n');

describe('diffLines', () => {
  it('is empty of changes when nothing changed', () => {
    const ops = diffLines('a\nb\n', 'a\nb\n');

    expect(diffStats(ops)).toEqual({ added: 0, removed: 0 });
    expect(ops.every((op) => op.kind === 'context')).toBe(true);
  });

  it('finds one changed line in a long file', () => {
    const before = numbered(1, 50);
    const after = before.replace('line 25', 'line twenty-five');

    const ops = diffLines(before, after);

    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
    expect(ops.filter((op) => op.kind === 'remove')).toEqual([{ kind: 'remove', text: 'line 25' }]);
  });

  it('reads an insertion as added lines only', () => {
    const ops = diffLines('a\nb\n', 'a\nnew\nb\n');

    expect(diffStats(ops)).toEqual({ added: 1, removed: 0 });
  });

  it('reads a deletion as removed lines only', () => {
    const ops = diffLines('a\ngone\nb\n', 'a\nb\n');

    expect(diffStats(ops)).toEqual({ added: 0, removed: 1 });
  });

  it('treats a trailing newline as the end of the last line, not a line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });

  it('calls the whole middle a replacement when the two sides share nothing', () => {
    // Past the edit-distance ceiling, so the shortest edit script is not worth
    // finding: what matters is that the result is still a correct diff.
    const before = Array.from({ length: 700 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 700 }, (_, i) => `new ${i}`).join('\n');

    const ops = diffLines(before, after);

    expect(diffStats(ops)).toEqual({ added: 700, removed: 700 });
  });
});

describe('toHunks', () => {
  it('numbers a hunk from the line it starts on in each file', () => {
    const before = numbered(1, 50);
    const after = before.replace('line 25', 'line twenty-five');

    const [hunk, ...rest] = toHunks(diffLines(before, after));

    expect(rest).toEqual([]);
    // Three lines of context above line 25, on both sides.
    expect(hunk.beforeStart).toBe(22);
    expect(hunk.afterStart).toBe(22);
    expect(hunk.beforeCount).toBe(7);
    expect(hunk.afterCount).toBe(7);
  });

  it('keeps two nearby changes in one hunk and distant ones apart', () => {
    const before = numbered(1, 60);
    const near = before.replace('line 10', 'ten').replace('line 12', 'twelve');
    const far = before.replace('line 10', 'ten').replace('line 50', 'fifty');

    expect(toHunks(diffLines(before, near))).toHaveLength(1);
    expect(toHunks(diffLines(before, far))).toHaveLength(2);
  });

  it('does not run off the start or end of the file', () => {
    const [hunk] = toHunks(diffLines('a\nb\n', 'changed\nb\n'));

    expect(hunk.beforeStart).toBe(1);
    expect(hunk.lines).toHaveLength(3);
  });
});

describe('formatUnified', () => {
  it('writes a header and signs every line', () => {
    const text = formatUnified(toHunks(diffLines('a\nb\nc\n', 'a\nB\nc\n')), 100);

    expect(text.split('\n')).toEqual(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c']);
  });

  it('says how many lines it left out', () => {
    const before = numbered(1, 40);
    const after = numbered(1, 40)
      .split('\n')
      .map((line) => `${line}!`)
      .join('\n');

    const text = formatUnified(toHunks(diffLines(before, after)), 10);

    expect(text).toContain('… 70 more changed lines not shown');
    // Ten lines of the change, plus the hunk header and the notice - the cap
    // counts the diff, not the scaffolding that says where it sits.
    expect(text.split('\n')).toHaveLength(12);
    expect(text.split('\n')[0]).toMatch(/^@@ /);
  });
});

describe('diffLineKind', () => {
  it('tells the parts of a diff apart', () => {
    expect(diffLineKind('@@ -1,3 +1,3 @@')).toBe('hunk');
    expect(diffLineKind('+added')).toBe('add');
    expect(diffLineKind('-removed')).toBe('remove');
    expect(diffLineKind(' kept')).toBe('context');
    expect(diffLineKind('Edited a.ts (+1 -1)')).toBe('note');
  });
});
