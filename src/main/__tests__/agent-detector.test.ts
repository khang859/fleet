import { describe, it, expect } from 'vitest';
import { identifyAgent, stripAnsi } from '../agent-detector';

describe('identifyAgent', () => {
  it.each([
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['Claude', 'claude'],
    ['pi', 'pi'],
    ['codex', 'codex']
  ])('identifies %s as %s', (processName, expected) => {
    expect(identifyAgent(processName)).toBe(expected);
  });

  it('returns null for shells', () => {
    expect(identifyAgent('zsh')).toBeNull();
    expect(identifyAgent('bash')).toBeNull();
  });

  it('returns null for empty / undefined-like inputs', () => {
    expect(identifyAgent('')).toBeNull();
    expect(identifyAgent('   ')).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[31mhi\x1b[0m')).toBe('hi');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('before\x1b]0;title\x07after')).toBe('beforeafter');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});
