import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signIn, resolveAuth } from '../auth';
import { AgentMcpSecrets } from '../secrets';
import { startFakeOAuthServer, approve, refuse, type FakeOAuthServer } from './fake-oauth-server';
import type { McpServerConfig } from '../../../../shared/agent-mcp';

/**
 * The sign-in, walked end to end against a real authorization server.
 *
 * This is the test that matters most in the whole feature: OAuth fails quietly.
 * A flow that opens a browser, comes back, and stores nothing looks exactly like
 * one that worked until the next request goes out without a token.
 */

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

let server: FakeOAuthServer;
let secrets: AgentMcpSecrets;
let opened: string[];

/** Resolves with the URL the app opened, so a test can play the browser. */
function browser(): { openExternal: (url: string) => Promise<void>; opened: Promise<string> } {
  let arrived: (url: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    arrived = resolve;
  });
  return {
    openExternal: async (url) => {
      opened.push(url);
      arrived(url);
      return Promise.resolve();
    },
    opened: promise
  };
}

beforeEach(async () => {
  server = await startFakeOAuthServer();
  secrets = new AgentMcpSecrets({ store: store(), safeStorage });
  opened = [];
});

afterEach(async () => {
  await server.close();
});

function config(): McpServerConfig {
  return { url: server.mcpUrl, enabled: true, auth: { kind: 'oauth' } };
}

describe('signing in to an MCP server', () => {
  it('gets a token the server will accept, without ever being told what it is', async () => {
    const ui = browser();
    const flow = signIn('demo', config(), { secrets, openExternal: ui.openExternal });

    await approve(server, await ui.opened);
    await flow;

    // Registered itself, exchanged a code, and kept what came back - none of
    // which the caller supplied, because none of it can be typed in.
    expect(server.registrations).toHaveLength(1);
    expect(secrets.isSignedIn('demo')).toBe(true);
    expect(secrets.tokens('demo')?.access_token).toBe('access-granted');
  });

  it('proves it holds the verifier, rather than only the code', async () => {
    const ui = browser();
    const flow = signIn('demo', config(), { secrets, openExternal: ui.openExternal });
    const authorize = new URL(await ui.opened);
    await approve(server, authorize.toString());
    await flow;

    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    // The fake server rejects a verifier that does not hash to the challenge,
    // so a token at all means PKCE was completed rather than skipped.
    expect(server.tokenRequests[0].get('code_verifier')).toBeTruthy();
  });

  it('opens the browser at the authorization server, not inside the app', async () => {
    const ui = browser();
    const flow = signIn('demo', config(), { secrets, openExternal: ui.openExternal });
    await approve(server, await ui.opened);
    await flow;

    expect(opened).toHaveLength(1);
    expect(opened[0].startsWith(`${server.issuer}/authorize`)).toBe(true);
  });

  it('comes back to a loopback address it is listening on', async () => {
    const ui = browser();
    const flow = signIn('demo', config(), { secrets, openExternal: ui.openExternal });
    const authorize = new URL(await ui.opened);
    await approve(server, authorize.toString());
    await flow;

    const redirect = authorize.searchParams.get('redirect_uri') ?? '';
    expect(redirect.startsWith('http://127.0.0.1:')).toBe(true);
    expect(server.tokenRequests[0].get('redirect_uri')).toBe(redirect);
  });

  it('refuses a redirect carrying a state it never sent', async () => {
    const ui = browser();
    const failed = fails(signIn('demo', config(), { secrets, openExternal: ui.openExternal }));

    await approve(server, await ui.opened, { state: 'from-somewhere-else' });

    expect(await failed).toMatch(/did not send it/);
    // The code is never exchanged, which is the whole point: it was not ours.
    expect(server.tokenRequests).toHaveLength(0);
    expect(secrets.isSignedIn('demo')).toBe(false);
  });

  it('refuses a redirect claiming to come from a different issuer', async () => {
    const ui = browser();
    const failed = fails(signIn('demo', config(), { secrets, openExternal: ui.openExternal }));

    await approve(server, await ui.opened, { iss: 'https://not-the-one.example' });

    expect(await failed).toMatch(/Issuer mismatch/);
    // RFC 9207, checked before the code is spent rather than after: the mixup
    // this stops is one where the code goes to the wrong token endpoint.
    expect(server.tokenRequests).toHaveLength(0);
    expect(secrets.isSignedIn('demo')).toBe(false);
  });

  it('says what the user was told when they say no', async () => {
    const ui = browser();
    const failed = fails(signIn('demo', config(), { secrets, openExternal: ui.openExternal }));

    await refuse(await ui.opened);

    expect(await failed).toMatch(/The user said no/);
    expect(secrets.isSignedIn('demo')).toBe(false);
  });

  it('stops when the user cancels, rather than waiting on a tab forever', async () => {
    const cancel = new AbortController();
    const ui = browser();
    const failed = fails(
      signIn('demo', config(), { secrets, openExternal: ui.openExternal }, cancel.signal)
    );

    await ui.opened;
    cancel.abort();

    expect(await failed).toMatch(/cancelled/);
  });

  it('does nothing at all when the stored token still works', async () => {
    const first = browser();
    const flow = signIn('demo', config(), { secrets, openExternal: first.openExternal });
    await approve(server, await first.opened);
    await flow;

    const again = browser();
    await signIn('demo', config(), { secrets, openExternal: again.openExternal });

    // One browser trip in total. A second one for a server we are already signed
    // in to is a window appearing for no reason.
    expect(opened).toHaveLength(1);
    expect(server.registrations).toHaveLength(1);
  });

  it('will not try to sign in to something it launches', async () => {
    const local: McpServerConfig = {
      command: 'node',
      args: [],
      enabled: true,
      auth: { kind: 'oauth' }
    };

    await expect(
      signIn('demo', local, { secrets, openExternal: async () => Promise.resolve() })
    ).rejects.toThrow(/over HTTP/);
  });
});

describe('what gets sent when connecting', () => {
  it('sends nothing for a server that asks for nothing', () => {
    expect(
      resolveAuth('demo', { url: server.mcpUrl, enabled: true }, { secrets, openExternal: opener })
    ).toBeUndefined();
  });

  it('sends a static token as a bearer header', () => {
    secrets.setToken('demo', 'sekrit');
    const auth = resolveAuth(
      'demo',
      { url: server.mcpUrl, enabled: true, auth: { kind: 'bearer' } },
      { secrets, openExternal: opener }
    );

    expect(auth?.headers).toEqual({ Authorization: 'Bearer sekrit' });
  });

  it('sends nothing for a bearer server whose token was never set', () => {
    // Deliberately not an error. Sending no credential is what makes the server
    // answer 401, which is what puts the row in `needs-auth` with a button on it
    // rather than in `failed` with a message nobody can act on.
    const auth = resolveAuth(
      'demo',
      { url: server.mcpUrl, enabled: true, auth: { kind: 'bearer' } },
      { secrets, openExternal: opener }
    );

    expect(auth).toBeUndefined();
  });

  it('hands an OAuth server a provider that can refresh on its own', async () => {
    const ui = browser();
    const flow = signIn('demo', config(), { secrets, openExternal: ui.openExternal });
    await approve(server, await ui.opened);
    await flow;

    const auth = resolveAuth('demo', config(), { secrets, openExternal: opener });
    expect(await auth?.authProvider?.tokens()).toMatchObject({ access_token: 'access-granted' });
  });
});

const opener = async (): Promise<void> => Promise.resolve();

/**
 * Catch the failure at the moment the flow starts, and hand back its message.
 *
 * A sign-in that is going to fail fails while the test is still playing the
 * browser, so leaving `rejects` until the end leaves the rejection unhandled for
 * a tick - which Node reports as an error even though the test passes.
 */
async function fails(flow: Promise<void>): Promise<string> {
  return flow.then(
    () => 'it did not fail',
    (err: unknown) => (err instanceof Error ? err.message : String(err))
  );
}
