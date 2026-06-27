import { describe, it, expect } from 'vitest';
import { ChatSecrets } from '../chat-secrets';

type FakeData = {
  keyEnc?: string;
  searchKeyEnc?: string;
  searchKeysEnc?: Partial<Record<'tavily' | 'exa' | 'brave', string>>;
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

  it('keeps the search key in a separate slot from the chat key', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    s.setKey('sk-or-123');
    s.setSearchKey('tavily', 'tvly-abc');
    expect(s.hasSearchKey('tavily')).toBe(true);
    expect(s.getSearchKey('tavily')).toBe('tvly-abc');
    // Clearing the chat key leaves the search key intact.
    s.clearKey();
    expect(s.hasKey()).toBe(false);
    expect(s.hasSearchKey('tavily')).toBe(true);
  });

  it('stores a separate key per provider', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    s.setSearchKey('tavily', 'tvly-abc');
    s.setSearchKey('exa', 'exa-xyz');
    s.setSearchKey('brave', 'bsa-789');
    expect(s.getSearchKey('tavily')).toBe('tvly-abc');
    expect(s.getSearchKey('exa')).toBe('exa-xyz');
    expect(s.getSearchKey('brave')).toBe('bsa-789');
    // Re-setting one provider leaves the others intact.
    s.setSearchKey('exa', 'exa-new');
    expect(s.getSearchKey('exa')).toBe('exa-new');
    expect(s.getSearchKey('tavily')).toBe('tvly-abc');
  });

  it('returns null/false for a provider with no key', () => {
    const { store, safe } = makeFakes();
    const s = new ChatSecrets({ store, safeStorage: safe });
    s.setSearchKey('tavily', 'tvly-abc');
    expect(s.hasSearchKey('exa')).toBe(false);
    expect(s.getSearchKey('exa')).toBeNull();
  });

  it('reads a legacy single search key as the Tavily key', () => {
    // Pre-existing installs store the key under the legacy `searchKeyEnc` slot.
    const { store, safe } = makeFakes({
      searchKeyEnc: Buffer.from('tvly-legacy').toString('base64')
    });
    const s = new ChatSecrets({ store, safeStorage: safe });
    expect(s.hasSearchKey('tavily')).toBe(true);
    expect(s.getSearchKey('tavily')).toBe('tvly-legacy');
    // The legacy slot only backs Tavily, not the new providers.
    expect(s.hasSearchKey('exa')).toBe(false);
    // A new per-provider key takes precedence over the legacy slot.
    s.setSearchKey('tavily', 'tvly-new');
    expect(s.getSearchKey('tavily')).toBe('tvly-new');
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
