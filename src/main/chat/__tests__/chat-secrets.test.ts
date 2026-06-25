import { describe, it, expect } from 'vitest';
import { ChatSecrets } from '../chat-secrets';

function makeFakes() {
  let data: { keyEnc?: string } = {};
  const store = { get: () => data, set: (next: { keyEnc?: string }) => (data = next) };
  // Reversible fake "encryption": base64.
  const safe = {
    isEncryptionAvailable: () => true,
    encryptString: (p: string) => Buffer.from(p, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  };
  return { store, safe };
}

describe('ChatSecrets', () => {
  it('round-trips a key through encryption', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    expect(s.hasKey()).toBe(false);
    s.setKey('sk-or-123');
    expect(s.hasKey()).toBe(true);
    expect(s.getKey()).toBe('sk-or-123');
  });

  it('clears the key', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    s.setKey('sk-or-123');
    s.clearKey();
    expect(s.hasKey()).toBe(false);
    expect(s.getKey()).toBeNull();
  });

  it('throws on setKey when encryption is unavailable', () => {
    const { store } = makeFakes();
    const safe = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.from(''),
      decryptString: () => ''
    };
    const s = new ChatSecrets({ store, safeStorage: safe });
    expect(() => s.setKey('x')).toThrow();
  });
});
