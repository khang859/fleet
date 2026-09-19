import { describe, it, expect } from 'vitest';
import { daemonSocketPath, requestSchema } from '../protocol';

describe('requestSchema', () => {
  it('accepts a request, with or without stdin', () => {
    const req = { id: 1, verb: 'click', args: ['e1'], cwd: '/repo' };
    expect(requestSchema.parse(req)).toEqual(req);
    expect(requestSchema.parse({ ...req, stdin: 'keys Escape' }).stdin).toBe('keys Escape');
  });

  it('rejects a malformed request', () => {
    expect(requestSchema.safeParse({ id: '1', verb: 'click', args: [], cwd: '/' }).success).toBe(
      false
    );
    expect(requestSchema.safeParse({ id: 1, verb: 'click', args: [1], cwd: '/' }).success).toBe(
      false
    );
  });
});

describe('daemonSocketPath', () => {
  it('is stable per checkout and differs between checkouts', () => {
    expect(daemonSocketPath('/a/fleet')).toBe(daemonSocketPath('/a/fleet'));
    expect(daemonSocketPath('/a/fleet')).not.toBe(daemonSocketPath('/b/fleet'));
  });
});
