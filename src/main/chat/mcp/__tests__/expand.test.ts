import { describe, it, expect } from 'vitest';
import { expandVars, expandRecord, expandArray } from '../expand';

describe('expandVars', () => {
  const env = { TOKEN: 'abc123', EMPTY: '' };

  it('expands a known variable', () => {
    expect(expandVars('Bearer ${TOKEN}', env)).toBe('Bearer abc123');
  });

  it('expands unknown variables to empty string', () => {
    expect(expandVars('x${MISSING}y', env)).toBe('xy');
  });

  it('leaves an escaped $${VAR} literal', () => {
    expect(expandVars('$${TOKEN}', env)).toBe('${TOKEN}');
  });

  it('expands multiple references in one string', () => {
    expect(expandVars('${TOKEN}/${TOKEN}', env)).toBe('abc123/abc123');
  });

  it('passes through strings with no references', () => {
    expect(expandVars('plain text', env)).toBe('plain text');
  });
});

describe('expandRecord', () => {
  it('expands every value and returns undefined for undefined input', () => {
    const env = { K: 'v' };
    expect(expandRecord({ a: '${K}', b: 'lit' }, env)).toEqual({ a: 'v', b: 'lit' });
    expect(expandRecord(undefined, env)).toBeUndefined();
  });
});

describe('expandArray', () => {
  it('expands each element and returns undefined for undefined input', () => {
    const env = { P: '/srv' };
    expect(expandArray(['-y', '${P}'], env)).toEqual(['-y', '/srv']);
    expect(expandArray(undefined, env)).toBeUndefined();
  });
});
