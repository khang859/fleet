import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FleetOAuthProvider } from '../oauth';
import { AgentMcpSecrets } from '../secrets';
import { CALLBACK_URLS } from '../callback';

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`),
  decryptString: (enc: Buffer) => enc.toString().slice(4)
};

function store(): { get: () => Record<string, never>; set: (next: unknown) => void } {
  let data: unknown = {};
  return {
    get: () => JSON.parse(JSON.stringify(data)),
    set: (next) => {
      data = next;
    }
  };
}

let secrets: AgentMcpSecrets;
let opened: string[];
let provider: FleetOAuthProvider;

beforeEach(() => {
  secrets = new AgentMcpSecrets({ store: store(), safeStorage });
  opened = [];
  provider = new FleetOAuthProvider({
    server: 'linear',
    secrets,
    redirectUrl: CALLBACK_URLS[0],
    openExternal: async (url) => {
      opened.push(url);
      return Promise.resolve();
    }
  });
});

const ISSUER = 'https://auth.linear.app';
const TOKENS = { access_token: 'at-1', token_type: 'Bearer', issuer: ISSUER };

describe('FleetOAuthProvider', () => {
  it('registers as a native client, which is what makes a loopback redirect fine', () => {
    const meta = provider.clientMetadata;
    expect(meta.application_type).toBe('native');
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(meta.redirect_uris.every((uri) => uri.startsWith('http://127.0.0.1:'))).toBe(true);
  });

  it('registers every port it might come back on, not only the one in use', () => {
    // Not every authorization server honours RFC 8252's "any loopback port",
    // and a sign-in that breaks because something else took a port is
    // undiagnosable.
    expect(provider.clientMetadata.redirect_uris).toEqual(CALLBACK_URLS);
  });

  it('never asks for a client secret', () => {
    // One shipped inside a desktop app is not a secret. PKCE is what protects
    // the exchange.
    expect(JSON.stringify(provider.clientMetadata)).not.toContain('client_secret');
  });

  it('opens the sign-in in the user own browser', async () => {
    await provider.redirectToAuthorization(new URL('https://auth.linear.app/authorize?x=1'));
    expect(opened).toEqual(['https://auth.linear.app/authorize?x=1']);
  });

  it('round-trips tokens through the secret store, keyed by issuer', () => {
    provider.saveTokens(TOKENS);

    expect(provider.tokens({ issuer: ISSUER })).toEqual(TOKENS);
    expect(secrets.tokens('linear', ISSUER)).toEqual(TOKENS);
  });

  it('answers a token read that names no issuer, which is every request', () => {
    provider.saveTokens(TOKENS);
    expect(provider.tokens()?.access_token).toBe('at-1');
  });

  it('keeps a refreshed token, so the next start does not sign in again', () => {
    provider.saveTokens(TOKENS);
    provider.saveTokens({ ...TOKENS, access_token: 'at-2', refresh_token: 'rt-2' });

    expect(provider.tokens()?.access_token).toBe('at-2');
    expect(provider.tokens()?.refresh_token).toBe('rt-2');
  });

  it('prefers the issuer stamped on the credential over the one passed alongside', () => {
    // SEP-2352 puts it on the value precisely so a credential carries its own
    // binding; the context is the older way of saying the same thing.
    provider.saveTokens({ ...TOKENS, issuer: 'https://stamped.example' }, { issuer: ISSUER });

    expect(secrets.tokens('linear', 'https://stamped.example')).not.toBeNull();
    expect(secrets.tokens('linear', ISSUER)).toBeNull();
  });

  it('round-trips a client registration', () => {
    provider.saveClientInformation({ client_id: 'id-1', issuer: ISSUER });
    expect(provider.clientInformation({ issuer: ISSUER })?.client_id).toBe('id-1');
  });

  it('has no registration for a server it has never registered with', () => {
    expect(provider.clientInformation({ issuer: 'https://new.example' })).toBeUndefined();
  });

  it('holds the PKCE verifier without writing it anywhere', () => {
    provider.saveCodeVerifier('verifier-1');

    expect(provider.codeVerifier()).toBe('verifier-1');
    // A secret at rest to survive something that cannot happen: the app stays
    // running for the trip out to the browser and back.
    expect(JSON.stringify(store().get())).not.toContain('verifier-1');
  });

  it('says so rather than exchanging a code against no verifier at all', () => {
    expect(() => provider.codeVerifier()).toThrow(/no sign-in in progress/);
  });

  it('accepts back only the state it sent', () => {
    const sent = provider.state();

    expect(provider.matchesState(sent)).toBe(true);
    expect(provider.matchesState('something-else')).toBe(false);
    expect(provider.matchesState(undefined)).toBe(false);
  });

  it('rejects a redirect when no flow ever started', () => {
    // The SDK does not check state and says so, so a provider that had sent
    // nothing must not accept anything.
    expect(provider.matchesState('anything')).toBe(false);
  });

  it('sends a different state every time', () => {
    const first = provider.state();
    const second = provider.state();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    // The earlier one is spent: a redirect from the abandoned flow must not
    // still be good.
    expect(provider.matchesState(first)).toBe(false);
  });

  it('caches discovery, so a second call does not go asking again', () => {
    expect(provider.discoveryState()).toBeUndefined();

    provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.linear.app' });

    expect(provider.discoveryState()).toEqual({
      authorizationServerUrl: 'https://auth.linear.app'
    });
  });

  it('drops the discovery cache when told the credentials are stale', () => {
    provider.saveDiscoveryState({ authorizationServerUrl: 'https://auth.linear.app' });
    provider.invalidateCredentials('discovery');
    expect(provider.discoveryState()).toBeUndefined();
  });

  it('throws away what it is told to and keeps the rest', () => {
    provider.saveTokens(TOKENS);
    provider.saveClientInformation({ client_id: 'id-1', issuer: ISSUER });

    provider.invalidateCredentials('tokens');
    expect(provider.tokens()).toBeUndefined();
    expect(provider.clientInformation({ issuer: ISSUER })?.client_id).toBe('id-1');

    provider.invalidateCredentials('all');
    expect(provider.clientInformation({ issuer: ISSUER })).toBeUndefined();
  });

  it('forgets the verifier when the flow is abandoned', () => {
    provider.saveCodeVerifier('verifier-1');
    provider.invalidateCredentials('verifier');
    expect(() => provider.codeVerifier()).toThrow();
  });
});

describe('what the provider hands the SDK', () => {
  it('is the shape the SDK asks for', () => {
    // The provider is passed straight to a transport, so what matters is that
    // every method the SDK reaches for is there and callable.
    const asProvider = provider;
    expect(typeof asProvider.redirectUrl).toBe('string');
    expect(typeof asProvider.clientMetadata).toBe('object');
    expect(vi.isMockFunction(asProvider.saveTokens)).toBe(false);
    expect(typeof asProvider.saveTokens).toBe('function');
    expect(typeof asProvider.tokens).toBe('function');
    expect(typeof asProvider.saveCodeVerifier).toBe('function');
    expect(typeof asProvider.codeVerifier).toBe('function');
    expect(typeof asProvider.redirectToAuthorization).toBe('function');
  });
});
