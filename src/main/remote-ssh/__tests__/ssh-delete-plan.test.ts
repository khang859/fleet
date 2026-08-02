import { describe, it, expect } from 'vitest';
import { parseDeletePlan, deletePlanToBatch } from '../ssh-delete-plan';

describe('parseDeletePlan', () => {
  it('parses NUL-delimited bottom-up find output', () => {
    const stdout =
      'f\t/home/k/dir/a.txt\0' +
      'f\t/home/k/dir/sub/b.txt\0' +
      'd\t/home/k/dir/sub\0' +
      'd\t/home/k/dir\0';
    expect(parseDeletePlan(stdout)).toEqual([
      { kind: 'file', path: '/home/k/dir/a.txt' },
      { kind: 'file', path: '/home/k/dir/sub/b.txt' },
      { kind: 'dir', path: '/home/k/dir/sub' },
      { kind: 'dir', path: '/home/k/dir' }
    ]);
  });

  it('preserves a filename containing a newline', () => {
    const nodes = parseDeletePlan('f\t/tmp/new\nline.txt\0d\t/tmp\0');
    expect(nodes[0].path).toBe('/tmp/new\nline.txt');
    expect(nodes).toHaveLength(2);
  });

  it('skips malformed records', () => {
    expect(parseDeletePlan('nonsense\0f\t/tmp/a\0')).toEqual([{ kind: 'file', path: '/tmp/a' }]);
  });

  it('returns empty for empty output', () => {
    expect(parseDeletePlan('')).toEqual([]);
  });
});

describe('deletePlanToBatch', () => {
  it('emits rm for files and rmdir for directories, preserving order', () => {
    expect(
      deletePlanToBatch([
        { kind: 'file', path: '/tmp/d/a.txt' },
        { kind: 'dir', path: '/tmp/d' }
      ])
    ).toEqual(['rm "/tmp/d/a.txt"', 'rmdir "/tmp/d"']);
  });

  it('quotes paths so shell metacharacters are inert', () => {
    expect(deletePlanToBatch([{ kind: 'file', path: '/tmp/semi;rm -rf x.txt' }])).toEqual([
      'rm "/tmp/semi;rm -rf x.txt"'
    ]);
  });

  it('refuses a newline path rather than deleting the wrong file', () => {
    // Better to fail the operation than to address a different path than intended.
    expect(() => deletePlanToBatch([{ kind: 'file', path: '/tmp/new\nline.txt' }])).toThrow(
      /newline/
    );
  });

  it('preserves the bottom-up ordering it is given', () => {
    const nodes = parseDeletePlan('f\t/a/b/c.txt\0d\t/a/b\0d\t/a\0');
    expect(deletePlanToBatch(nodes)).toEqual(['rm "/a/b/c.txt"', 'rmdir "/a/b"', 'rmdir "/a"']);
  });
});
