import { describe, it, expect } from 'vitest';
import { parseVerbArgs } from '../dispatch';

describe('parseVerbArgs', () => {
  it('keeps text that starts with a dash as text', () => {
    expect(parseVerbArgs(['-1+1'])).toEqual({ values: {}, positionals: ['-1+1'] });
    expect(parseVerbArgs(['echo -n hi', '--enter'])).toEqual({
      values: { enter: true },
      positionals: ['echo -n hi']
    });
    expect(parseVerbArgs(['-hi']).positionals).toEqual(['-hi']);
  });

  it('reads string flags with a space or an equals sign', () => {
    expect(parseVerbArgs(['--out', 'a.png', '--timeout=100', '--selector=a=b']).values).toEqual({
      out: 'a.png',
      timeout: '100',
      selector: 'a=b'
    });
  });

  it('makes everything after -- text', () => {
    expect(parseVerbArgs(['--shot', '--', '--shot', '--nope'])).toEqual({
      values: { shot: true },
      positionals: ['--shot', '--nope']
    });
  });

  it('rejects an unknown flag, a missing value and a value on a boolean', () => {
    expect(() => parseVerbArgs(['--shto'])).toThrow('Unknown flag: --shto');
    expect(() => parseVerbArgs(['--out'])).toThrow('--out needs a value');
    expect(() => parseVerbArgs(['--shot=yes'])).toThrow('--shot takes no value');
  });
});
