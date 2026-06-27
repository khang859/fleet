import { describe, it, expect } from 'vitest';
import { classifyStreamError } from '../stream-error';

describe('classifyStreamError', () => {
  it('classifies auth errors as non-retryable config problems', () => {
    const info = classifyStreamError('401 Unauthorized: invalid API key');
    expect(info.kind).toBe('auth');
    expect(info.retryable).toBe(false);
    expect(info.detail).toMatch(/settings/i);
  });

  it('classifies quota / rate-limit errors as retryable config problems', () => {
    expect(classifyStreamError('402 insufficient credits').kind).toBe('quota');
    expect(classifyStreamError('429 Too Many Requests').kind).toBe('quota');
    expect(classifyStreamError('rate limit exceeded').retryable).toBe(true);
  });

  it('classifies network errors as retryable', () => {
    const info = classifyStreamError('fetch failed: ECONNRESET');
    expect(info.kind).toBe('network');
    expect(info.retryable).toBe(true);
  });

  it('falls back to a generic, retryable error that surfaces the raw message', () => {
    const info = classifyStreamError('model produced no output');
    expect(info.kind).toBe('generic');
    expect(info.retryable).toBe(true);
    expect(info.detail).toContain('model produced no output');
  });

  it('handles a null/empty message without leaking a raw code', () => {
    const info = classifyStreamError(null);
    expect(info.kind).toBe('generic');
    expect(info.detail).toMatch(/try again/i);
  });
});
