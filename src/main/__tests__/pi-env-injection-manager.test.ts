import { describe, it, expect } from 'vitest';
import { PiBedrockInjectionSchema, PiEnvInjectionSchema } from '../../shared/pi-env-injection-types';
import type { PiEnvInjection } from '../../shared/pi-env-injection-types';
import { PiEnvInjectionManager } from '../pi-env-injection-manager';

/** In-memory store for tests; matches the subset of electron-store used by the manager. */
class FakeStore {
  private data: PiEnvInjection = {};
  get(): PiEnvInjection {
    return this.data;
  }
  set(next: PiEnvInjection): void {
    this.data = next;
  }
}

/** Deterministic safeStorage fake: prepends a marker so encrypt/decrypt are distinguishable. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (buf: Buffer) => {
    const s = buf.toString('utf-8');
    if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
    return s.slice(4);
  }
};

describe('PiBedrockInjectionSchema', () => {
  it('defaults mode to "chain"', () => {
    const parsed = PiBedrockInjectionSchema.parse({});
    expect(parsed.mode).toBe('chain');
  });

  it('accepts all three modes', () => {
    for (const mode of ['profile', 'keys', 'chain'] as const) {
      expect(PiBedrockInjectionSchema.parse({ mode }).mode).toBe(mode);
    }
  });

  it('preserves unknown sibling keys via passthrough', () => {
    const parsed = PiEnvInjectionSchema.parse({
      bedrock: { mode: 'profile', profile: 'dev' },
      futureProvider: { apiKey: 'x' }
    });
    expect(parsed).toMatchObject({ futureProvider: { apiKey: 'x' } });
  });
});

describe('PiEnvInjectionManager — writeBedrock/getRedactedConfig', () => {
  it('round-trips plaintext fields and marks secret fields as present', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });

    mgr.writeBedrock({
      mode: 'keys',
      region: 'us-west-2',
      accessKeyId: 'AKIA…',
      secretAccessKey: 'SECRET!'
    });

    const redacted = mgr.getRedactedConfig().bedrock;
    expect(redacted).toEqual({
      mode: 'keys',
      region: 'us-west-2',
      accessKeyId: 'AKIA…',
      secretAccessKeyPresent: true,
      sessionTokenPresent: false
    });
  });

  it('encrypts secrets before persisting', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });

    mgr.writeBedrock({ mode: 'keys', secretAccessKey: 'plaintext-secret' });

    const raw = store.get();
    expect(raw.bedrock?.secretAccessKeyEnc).toBeDefined();
    expect(raw.bedrock?.secretAccessKeyEnc).not.toContain('plaintext-secret');
  });

  it('clearBedrockSecret removes only the named field', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });

    mgr.writeBedrock({
      mode: 'keys',
      secretAccessKey: 'sek',
      sessionToken: 'st'
    });
    mgr.clearBedrockSecret('secretAccessKey');

    const redacted = mgr.getRedactedConfig().bedrock;
    expect(redacted?.secretAccessKeyPresent).toBe(false);
    expect(redacted?.sessionTokenPresent).toBe(true);
  });

  it('write with safeStorage unavailable throws when secrets are supplied', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({
      store,
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false }
    });

    expect(() => mgr.writeBedrock({ mode: 'keys', secretAccessKey: 'x' })).toThrow(/encryption/i);
  });

  it('write with safeStorage unavailable succeeds when no secrets are supplied', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({
      store,
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false }
    });

    expect(() =>
      mgr.writeBedrock({ mode: 'profile', profile: 'dev', region: 'us-east-1' })
    ).not.toThrow();
  });
});

describe('PiEnvInjectionManager.getInjectedEnv', () => {
  const buildMgr = (bedrock: PiEnvInjection['bedrock']): PiEnvInjectionManager => {
    const store = new FakeStore();
    store.set({ bedrock });
    return new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });
  };

  it('mode=chain writes only AWS_REGION when present', () => {
    const mgr = buildMgr({ mode: 'chain', region: 'eu-central-1' });
    expect(mgr.getInjectedEnv()).toEqual({ AWS_REGION: 'eu-central-1' });
  });

  it('mode=chain with no region writes nothing', () => {
    const mgr = buildMgr({ mode: 'chain' });
    expect(mgr.getInjectedEnv()).toEqual({});
  });

  it('mode=profile writes AWS_PROFILE + AWS_REGION', () => {
    const mgr = buildMgr({ mode: 'profile', profile: 'dev', region: 'us-east-1' });
    expect(mgr.getInjectedEnv()).toEqual({ AWS_PROFILE: 'dev', AWS_REGION: 'us-east-1' });
  });

  it('mode=keys decrypts secretAccessKey and sessionToken', () => {
    const store = new FakeStore();
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });
    mgr.writeBedrock({
      mode: 'keys',
      region: 'us-east-1',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      sessionToken: 'tok'
    });
    expect(mgr.getInjectedEnv()).toEqual({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'shh',
      AWS_SESSION_TOKEN: 'tok'
    });
  });

  it('skips fields whose decryption throws', () => {
    const store = new FakeStore();
    store.set({
      bedrock: {
        mode: 'keys',
        region: 'us-east-1',
        accessKeyId: 'AKIA',
        secretAccessKeyEnc: Buffer.from('corrupted').toString('base64')
      }
    });
    const mgr = new PiEnvInjectionManager({ store, safeStorage: fakeSafeStorage });
    expect(mgr.getInjectedEnv()).toEqual({ AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIA' });
  });
});
