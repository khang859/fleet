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

  it('classifies 5xx upstream failures as transient server errors, not raw dumps', () => {
    const info = classifyStreamError('OpenRouter request failed: 500 {"error":{"message":"boom"}}');
    expect(info.kind).toBe('server');
    expect(info.retryable).toBe(true);
    // The raw status line + JSON body must never be echoed into the bubble.
    expect(info.detail).not.toContain('500');
    expect(info.detail).not.toContain('{');
    expect(info.detail).toMatch(/try again/i);
  });

  it('classifies 502/503/504 and named gateway errors as server errors', () => {
    expect(classifyStreamError('502 Bad Gateway').kind).toBe('server');
    expect(classifyStreamError('503 Service Unavailable').kind).toBe('server');
    expect(classifyStreamError('upstream gateway timeout').kind).toBe('server');
  });

  it('does not misclassify large token counts as a 5xx server error', () => {
    // "5000" must not trip the \b5\d\d\b status-code matcher.
    expect(classifyStreamError('model produced 5000 tokens of garbage').kind).toBe('generic');
  });

  it('falls back to a generic, retryable error that surfaces a clean short message', () => {
    const info = classifyStreamError('model produced no output');
    expect(info.kind).toBe('generic');
    expect(info.retryable).toBe(true);
    expect(info.detail).toContain('model produced no output');
  });

  it('sanitizes a raw upstream dump in the generic branch (no status code / JSON)', () => {
    const info = classifyStreamError('weird failure {"trace":"abc","line":42}');
    expect(info.kind).toBe('generic');
    expect(info.detail).not.toContain('{');
    expect(info.detail).toMatch(/try again/i);
  });

  it('handles a null/empty message without leaking a raw code', () => {
    const info = classifyStreamError(null);
    expect(info.kind).toBe('generic');
    expect(info.detail).toMatch(/try again/i);
  });
});
