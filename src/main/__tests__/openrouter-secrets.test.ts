import { describe, it, expect } from 'vitest';
import { OpenRouterSecrets } from '../openrouter-secrets';

type FakeData = {
  keyEnc?: string;
};

function makeFakes(initial: FakeData = {}) {
  let data: FakeData = initial;
  const store = {
    get: () => data,
    set: (next: FakeData) => (data = next)
  };
  // Reversible fake "encryption": base64.
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (p: string) => Buffer.from(p, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  };
  return { store, safe };
}

describe('OpenRouterSecrets', () => {
  it('round-trips a key through encryption', () => {
    const { store, safe } = makeFakes();
    const s = new OpenRouterSecrets({ store, safeStorage: safe });
    expect(s.hasKey()).toBe(false);
    s.setKey('sk-or-123');
    expect(s.hasKey()).toBe(true);
    expect(s.getKey()).toBe('sk-or-123');
  });

  it('clears the key', () => {
    const { store, safe } = makeFakes();
    const s = new OpenRouterSecrets({ store, safeStorage: safe });
    s.setKey('sk-or-123');
    s.clearKey();
    expect(s.hasKey()).toBe(false);
    expect(s.getKey()).toBeNull();
  });

  it('returns null when the stored ciphertext cannot be decrypted', () => {
    const { store } = makeFakes({ keyEnc: 'not-really-encrypted' });
    const safe = {
      isEncryptionAvailable: () => true,
      encryptString: (p: string) => Buffer.from(p, 'utf8'),
      decryptString: () => {
        throw new Error('bad ciphertext');
      }
    };
    const s = new OpenRouterSecrets({ store, safeStorage: safe });
    expect(s.hasKey()).toBe(true);
    expect(s.getKey()).toBeNull();
  });

  it('throws on setKey when encryption is unavailable', () => {
    const { store } = makeFakes();
    const safe = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(''),
      decryptString: () => ''
    };
    const s = new OpenRouterSecrets({ store, safeStorage: safe });
    expect(() => s.setKey('x')).toThrow();
  });
});
