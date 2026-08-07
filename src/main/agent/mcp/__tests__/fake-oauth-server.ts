import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

const JsonRpcCall = z.object({ id: z.number().optional(), method: z.string().optional() });
const RegisteredMetadata = z.looseObject({ redirect_uris: z.array(z.string()) });

/**
 * A real authorization server and a real MCP endpoint, on one loopback port.
 *
 * The whole point of testing OAuth against this rather than against a stub is
 * that the SDK is what walks it: discovery, registration, PKCE, the code
 * exchange, the `iss` check. A stub would only prove Fleet agrees with the stub,
 * and the interesting failures - a redirect the server never sees, a token that
 * is never sent, a `start()` that reports success without asking anybody - all
 * live in the parts a stub replaces.
 *
 * Everything it was asked is recorded, so a test can assert on what actually
 * went over the wire rather than on what was meant to.
 */

export type FakeOAuthServer = {
  /** The issuer, and the base of every endpoint. */
  issuer: string;
  /** The MCP endpoint, which is what a server config points at. */
  mcpUrl: string;
  /** Client metadata documents posted to the registration endpoint. */
  registrations: unknown[];
  /** Every form posted to the token endpoint, in order. */
  tokenRequests: URLSearchParams[];
  /** Bearer tokens the MCP endpoint will accept. */
  accept: Set<string>;
  /** What the next code exchange mints. */
  nextAccessToken: string;
  close: () => Promise<void>;
};

export async function startFakeOAuthServer(): Promise<FakeOAuthServer> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const state: FakeOAuthServer = {
    issuer: '',
    mcpUrl: '',
    registrations: [],
    tokenRequests: [],
    accept: new Set<string>(),
    nextAccessToken: 'access-granted',
    close: async () => Promise.resolve()
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', state.issuer);

    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      // RFC 9728. The 401 points straight here, so no path guessing happens.
      json(res, { resource: state.mcpUrl, authorization_servers: [state.issuer] });
      return;
    }

    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/authorize`,
        token_endpoint: `${state.issuer}/token`,
        registration_endpoint: `${state.issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true
      });
      return;
    }

    if (url.pathname === '/register') {
      const metadata: unknown = JSON.parse(await body(req));
      state.registrations.push(metadata);
      // RFC 7591: the response echoes the registered metadata back, which is
      // what the client validates the registration against.
      json(res, { ...RegisteredMetadata.parse(metadata), client_id: 'client-1' }, 201);
      return;
    }

    if (url.pathname === '/token') {
      const form = new URLSearchParams(await body(req));
      state.tokenRequests.push(form);
      json(res, tokenFor(form, codes, state));
      return;
    }

    if (url.pathname === '/mcp') return mcp(req, res, state);

    res.writeHead(404).end();
  }

  pending.set(state, codes);
  await listen(server);
  state.issuer = `http://127.0.0.1:${portOf(server)}`;
  state.mcpUrl = `${state.issuer}/mcp`;
  state.close = async () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return state;
}

/**
 * Stand in for the user and their browser.
 *
 * Reads the authorization URL the app opened, does what a browser would - check
 * the query, follow the redirect - and lands on Fleet's callback listener. The
 * code is minted here rather than at the endpoint because nothing ever GETs
 * `/authorize`; the browser does, and this is the browser.
 */
export async function approve(
  server: FakeOAuthServer,
  authorizeUrl: string,
  overrides: { state?: string; iss?: string; code?: string } = {}
): Promise<void> {
  const opened = new URL(authorizeUrl);
  const redirect = opened.searchParams.get('redirect_uri');
  if (redirect === null) throw new Error('the app opened an authorize URL with no redirect_uri');

  const code = overrides.code ?? 'code-1';
  mint(server, code, opened.searchParams.get('code_challenge') ?? '', redirect);

  const back = new URL(redirect);
  back.searchParams.set('code', code);
  back.searchParams.set('state', overrides.state ?? opened.searchParams.get('state') ?? '');
  back.searchParams.set('iss', overrides.iss ?? server.issuer);
  await fetch(back);
}

/** The browser coming back with a refusal instead of a code. */
export async function refuse(authorizeUrl: string, error = 'access_denied'): Promise<void> {
  const opened = new URL(authorizeUrl);
  const back = new URL(opened.searchParams.get('redirect_uri') ?? '');
  back.searchParams.set('error', error);
  back.searchParams.set('error_description', 'The user said no.');
  back.searchParams.set('state', opened.searchParams.get('state') ?? '');
  await fetch(back);
}

const pending = new WeakMap<
  FakeOAuthServer,
  Map<string, { challenge: string; redirect: string }>
>();

function mint(server: FakeOAuthServer, code: string, challenge: string, redirect: string): void {
  const codes = pending.get(server);
  if (codes === undefined) throw new Error('the fake server is not running');
  codes.set(code, { challenge, redirect });
}

function tokenFor(
  form: URLSearchParams,
  codes: Map<string, { challenge: string; redirect: string }>,
  server: FakeOAuthServer
): Record<string, unknown> {
  if (form.get('grant_type') === 'refresh_token') {
    const token = `${server.nextAccessToken}-refreshed`;
    server.accept.add(token);
    return { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2' };
  }

  const code = form.get('code') ?? '';
  const issued = codes.get(code);
  if (issued === undefined) return { error: 'invalid_grant' };

  // PKCE, checked rather than assumed: a verifier that does not hash to the
  // challenge is the case the whole exchange exists to stop.
  const verifier = form.get('code_verifier') ?? '';
  const hashed = createHash('sha256').update(verifier).digest('base64url');
  if (hashed !== issued.challenge) return { error: 'invalid_grant' };

  codes.delete(code);
  server.accept.add(server.nextAccessToken);
  return {
    access_token: server.nextAccessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'rt-1'
  };
}

/**
 * The MCP endpoint: 401 without a token it knows, and a working handshake with
 * one.
 */
async function mcp(
  req: IncomingMessage,
  res: ServerResponse,
  server: FakeOAuthServer
): Promise<void> {
  const sent = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!server.accept.has(sent)) {
    res
      .writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${server.issuer}/.well-known/oauth-protected-resource/mcp"`
      })
      .end();
    return;
  }

  const call = JsonRpcCall.parse(JSON.parse(await body(req)));
  if (call.id === undefined) {
    res.writeHead(202).end();
    return;
  }

  if (call.method === 'initialize') {
    json(res, {
      jsonrpc: '2.0',
      id: call.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' }
      }
    });
    return;
  }

  if (call.method === 'tools/list') {
    json(res, { jsonrpc: '2.0', id: call.id, result: { tools: [] } });
    return;
  }

  // Anything else, including the version-negotiation probe, which a server of
  // this era does not recognise.
  json(res, {
    jsonrpc: '2.0',
    id: call.id,
    error: { code: -32601, message: 'Method not found' }
  });
}

function json(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return (address satisfies AddressInfo).port;
}
