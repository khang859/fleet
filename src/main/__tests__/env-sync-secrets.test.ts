import { describe, it, expect } from 'vitest';
import { EnvSyncSecrets, type EnvSyncSecretsData } from '../env-sync/env-sync-secrets';

class FakeStore {
  private data: EnvSyncSecretsData = { repoOverrides: {} };
  get(): EnvSyncSecretsData {
    return this.data;
  }
  set(next: EnvSyncSecretsData): void {
    this.data = next;
  }
}

const fakeSafe = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => {
    const s = buf.toString('utf8');
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
    return s.slice(4);
  }
};

function make() {
  return new EnvSyncSecrets({ store: new FakeStore(), safeStorage: fakeSafe });
}

describe('EnvSyncSecrets', () => {
  it('redacts: presence flags only, never plaintext', () => {
    const s = make();
    s.setGlobalPassphrase('global-pw');
    s.setRepoPassphrase('app', 'repo-pw');
    const r = s.getRedacted();
    expect(r).toEqual({ globalPresent: true, repoOverrides: { app: { present: true } }, authRepoOverrides: {} });
  });

  it('resolves repo override before global', () => {
    const s = make();
    s.setGlobalPassphrase('global-pw');
    s.setRepoPassphrase('app', 'repo-pw');
    expect(s.resolvePassphrase('app')).toBe('repo-pw');
    expect(s.resolvePassphrase('other')).toBe('global-pw');
  });

  it('throws when no passphrase is configured', () => {
    expect(() => make().resolvePassphrase('app')).toThrow(/no passphrase/i);
  });

  it('clears passphrases', () => {
    const s = make();
    s.setGlobalPassphrase('g');
    s.clearGlobalPassphrase();
    expect(s.getRedacted().globalPresent).toBe(false);
  });

  it('refuses to store when encryption unavailable', () => {
    const s = new EnvSyncSecrets({ store: new FakeStore(), safeStorage: { ...fakeSafe, isEncryptionAvailable: () => false } });
    expect(() => s.setGlobalPassphrase('x')).toThrow(/encryption/i);
  });
});

describe('EnvSyncSecrets AWS auth', () => {
  it('defaults to default-chain when nothing is configured', () => {
    expect(make().resolveAuth('app')).toEqual({ mode: 'default-chain' });
  });

  it('resolves a repo override before the global default', () => {
    const s = make();
    s.setGlobalAuth({ mode: 'profile', profile: 'global-profile' });
    s.setRepoAuth('app', { mode: 'profile', profile: 'app-profile' });
    expect(s.resolveAuth('app')).toEqual({ mode: 'profile', profile: 'app-profile' });
    expect(s.resolveAuth('other')).toEqual({ mode: 'profile', profile: 'global-profile' });
  });

  it('round-trips static keys through safeStorage and never returns them in the redacted view', () => {
    const s = make();
    s.setGlobalAuth({ mode: 'static', accessKeyId: 'AKIA123', secretAccessKey: 'shh', sessionToken: 'tok' });
    expect(s.resolveAuth('app')).toEqual({
      mode: 'static',
      profile: undefined,
      accessKeyId: 'AKIA123',
      secretAccessKey: 'shh',
      sessionToken: 'tok'
    });
    expect(s.getRedacted().globalAuth).toEqual({
      mode: 'static',
      profile: undefined,
      hasAccessKeyId: true,
      hasSecretAccessKey: true,
      hasSessionToken: true
    });
  });

  it('redacts a per-repo profile override with presence flags', () => {
    const s = make();
    s.setRepoAuth('app', { mode: 'profile', profile: 'work' });
    expect(s.getRedacted().authRepoOverrides).toEqual({
      app: { mode: 'profile', profile: 'work', hasAccessKeyId: false, hasSecretAccessKey: false, hasSessionToken: false }
    });
  });

  it('clears auth back to the default chain', () => {
    const s = make();
    s.setGlobalAuth({ mode: 'profile', profile: 'work' });
    s.clearGlobalAuth();
    expect(s.getRedacted().globalAuth).toBeUndefined();
    expect(s.resolveAuth('app')).toEqual({ mode: 'default-chain' });
  });

  it('refuses to store static keys when encryption is unavailable', () => {
    const s = new EnvSyncSecrets({ store: new FakeStore(), safeStorage: { ...fakeSafe, isEncryptionAvailable: () => false } });
    expect(() => s.setGlobalAuth({ mode: 'static', accessKeyId: 'a', secretAccessKey: 'b' })).toThrow(/encryption/i);
  });

  it('allows storing a profile mode without encryption (no secrets involved)', () => {
    const s = new EnvSyncSecrets({ store: new FakeStore(), safeStorage: { ...fakeSafe, isEncryptionAvailable: () => false } });
    s.setGlobalAuth({ mode: 'profile', profile: 'work' });
    expect(s.resolveAuth('app')).toEqual({ mode: 'profile', profile: 'work' });
  });
});
