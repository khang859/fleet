import { describe, it, expect, beforeEach } from 'vitest';
import { AgentMcpSecrets } from '../secrets';

/**
 * A keychain that works, and one that has forgotten its key.
 *
 * The second is the case worth covering: a restored machine or a new user
 * leaves ciphertext behind that nothing can read, and the right outcome is a
 * pane the user can sign in on again rather than one that will not open.
 */
function fakeSafeStorage(working = true): {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
} {
  return {
    isEncryptionAvailable: () => working,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (enc) => {
      const text = enc.toString();
      if (!text.startsWith('enc:')) throw new Error('cannot decrypt');
      return text.slice(4);
    }
  };
}

function fakeStore(): { get: () => Record<string, never>; set: (next: unknown) => void } {
  let data: unknown = {};
  return {
    // Round-tripped through JSON, the way electron-store really stores it, so
    // a value that would not survive the trip fails here rather than in use.
    get: () => JSON.parse(JSON.stringify(data)),
    set: (next) => {
      data = next;
    }
  };
}

let secrets: AgentMcpSecrets;

beforeEach(() => {
  secrets = new AgentMcpSecrets({ store: fakeStore(), safeStorage: fakeSafeStorage() });
});

const TOKENS = { access_token: 'at-1', token_type: 'Bearer', refresh_token: 'rt-1' };

describe('AgentMcpSecrets', () => {
  it('keeps a static token per server', () => {
    secrets.setToken('linear', 'sekrit');
    secrets.setToken('notion', 'other');

    expect(secrets.getToken('linear')).toBe('sekrit');
    expect(secrets.getToken('notion')).toBe('other');
    expect(secrets.getToken('never-set')).toBeNull();
  });

  it('never writes a token in the clear', () => {
    const store = fakeStore();
    new AgentMcpSecrets({ store, safeStorage: fakeSafeStorage() }).setToken('linear', 'sekrit');

    expect(JSON.stringify(store.get())).not.toContain('sekrit');
  });

  it('round-trips OAuth tokens under the issuer that granted them', () => {
    secrets.saveTokens('linear', 'https://auth.linear.app', TOKENS);

    expect(secrets.tokens('linear', 'https://auth.linear.app')).toEqual(TOKENS);
    expect(secrets.tokens('linear', 'https://elsewhere.example')).toBeNull();
  });

  it('answers the most recent set when nobody says which issuer', () => {
    // Which is how the transport asks, before every request.
    secrets.saveTokens('linear', 'https://old.example', TOKENS);
    secrets.saveTokens('linear', 'https://new.example', { ...TOKENS, access_token: 'at-2' });

    expect(secrets.tokens('linear')?.access_token).toBe('at-2');
  });

  it('keeps a client registration apart per issuer', () => {
    secrets.saveClient('linear', 'https://a.example', { client_id: 'id-a' });
    secrets.saveClient('linear', 'https://b.example', { client_id: 'id-b' });

    expect(secrets.client('linear', 'https://a.example')?.client_id).toBe('id-a');
    expect(secrets.client('linear', 'https://b.example')?.client_id).toBe('id-b');
  });

  it('says whether a server has ever finished signing in', () => {
    expect(secrets.isSignedIn('linear')).toBe(false);
    secrets.saveTokens('linear', 'https://auth.example', TOKENS);
    expect(secrets.isSignedIn('linear')).toBe(true);
  });

  it('throws away only what it was asked to', () => {
    secrets.saveTokens('linear', 'https://auth.example', TOKENS);
    secrets.saveClient('linear', 'https://auth.example', { client_id: 'id' });

    secrets.invalidate('linear', 'tokens');
    expect(secrets.tokens('linear')).toBeNull();
    expect(secrets.client('linear', 'https://auth.example')?.client_id).toBe('id');

    secrets.invalidate('linear', 'all');
    expect(secrets.client('linear', 'https://auth.example')).toBeNull();
  });

  it('leaves one server alone when another is forgotten', () => {
    secrets.setToken('linear', 'a');
    secrets.setToken('notion', 'b');

    secrets.forget('linear');

    expect(secrets.getToken('linear')).toBeNull();
    expect(secrets.getToken('notion')).toBe('b');
  });

  it('follows a server that gets renamed, rather than signing it out', () => {
    secrets.saveTokens('linear', 'https://auth.example', TOKENS);

    secrets.rename('linear', 'linear-eu');

    expect(secrets.isSignedIn('linear-eu')).toBe(true);
    expect(secrets.isSignedIn('linear')).toBe(false);
  });

  it('reads as signed out when the keychain can no longer decrypt', () => {
    const store = fakeStore();
    new AgentMcpSecrets({ store, safeStorage: fakeSafeStorage() }).saveTokens(
      'linear',
      'https://auth.example',
      TOKENS
    );

    // Same ciphertext, a keychain that has lost the key it was written under.
    const restored = new AgentMcpSecrets({
      store,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (plain) => Buffer.from(plain),
        decryptString: () => {
          throw new Error('no key');
        }
      }
    });

    expect(restored.tokens('linear')).toBeNull();
    expect(restored.isSignedIn('linear')).toBe(false);
  });

  it('says so rather than writing plaintext when there is no secure store', () => {
    const open = new AgentMcpSecrets({ store: fakeStore(), safeStorage: fakeSafeStorage(false) });

    expect(() => open.setToken('linear', 'sekrit')).toThrow(/not available/);
    expect(open.isEncryptionAvailable()).toBe(false);
  });

  it('reads as signed out when what was stored is not a token set', () => {
    const store = fakeStore();
    const safe = fakeSafeStorage();
    store.set({ linear: { oauthEnc: { iss: safe.encryptString('null').toString('base64') } } });

    expect(new AgentMcpSecrets({ store, safeStorage: safe }).tokens('linear', 'iss')).toBeNull();
  });
});
