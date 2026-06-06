import { describe, it, expect } from 'vitest';
import {
  authFingerprint,
  isPreconditionFailed,
  isConditionalConflict
} from '../env-sync/s3-client';

describe('authFingerprint', () => {
  it('is constant for the default chain', () => {
    expect(authFingerprint({ mode: 'default-chain' })).toBe('default-chain');
  });

  it('separates profiles by name', () => {
    expect(authFingerprint({ mode: 'profile', profile: 'work' })).not.toBe(
      authFingerprint({ mode: 'profile', profile: 'personal' })
    );
  });

  it('separates distinct static identities and stays stable for the same keys', () => {
    const a = authFingerprint({ mode: 'static', accessKeyId: 'AKIA1', secretAccessKey: 's1' });
    const b = authFingerprint({ mode: 'static', accessKeyId: 'AKIA2', secretAccessKey: 's2' });
    const a2 = authFingerprint({ mode: 'static', accessKeyId: 'AKIA1', secretAccessKey: 's1' });
    expect(a).not.toBe(b);
    expect(a).toBe(a2);
  });

  it('does not embed the raw secret in the fingerprint', () => {
    expect(
      authFingerprint({ mode: 'static', accessKeyId: 'AKIA1', secretAccessKey: 'super-secret' })
    ).not.toContain('super-secret');
  });
});

describe('conditional-write error classifiers', () => {
  it('treats 412 as a precondition failure, never a conditional conflict', () => {
    const err412 = { $metadata: { httpStatusCode: 412 }, name: 'PreconditionFailed' };
    expect(isPreconditionFailed(err412)).toBe(true);
    expect(isConditionalConflict(err412)).toBe(false);
  });

  it('treats 409 as a conditional conflict, never a precondition failure', () => {
    const err409 = { $metadata: { httpStatusCode: 409 }, name: 'ConditionalRequestConflict' };
    expect(isConditionalConflict(err409)).toBe(true);
    expect(isPreconditionFailed(err409)).toBe(false);
  });
});
