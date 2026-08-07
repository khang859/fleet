import { Client, UnauthorizedError } from '@modelcontextprotocol/client';
import type { McpServerConfig } from '../../../shared/agent-mcp';
import { transportOf } from '../../../shared/agent-mcp';
import type { AgentMcpSecrets } from './secrets';
import { FleetOAuthProvider } from './oauth';
import { startCallback, DEFAULT_CALLBACK_URL } from './callback';
import { httpTransport, type TransportAuth } from './transport';
import { createLogger } from '../../logger';

const log = createLogger('agent-mcp-auth');

/**
 * How a server is authenticated: what to send when connecting, and what to run
 * when nothing has been sent yet.
 *
 * The two are deliberately separate. Connecting must never open a browser -
 * that would mean a window appearing because the app started - so a server that
 * has no credentials fails to connect and waits, and signing in happens because
 * the user asked for it.
 */

export type AuthDeps = {
  secrets: AgentMcpSecrets;
  /** `shell.openExternal` in the app; a spy in tests. */
  openExternal: (url: string) => Promise<void>;
};

/**
 * What one server needs to prove who we are, if anything.
 *
 * `undefined` for a server that wants nothing, and also for one that wants a
 * token it does not have: sending no credential is what makes the server answer
 * 401, which is what puts it in `needs-auth` with a button rather than in
 * `failed` with an error.
 */
export function resolveAuth(
  server: string,
  cfg: McpServerConfig,
  deps: AuthDeps
): TransportAuth | undefined {
  // Headers and environment values that were lifted out of the config when it
  // was imported. Separate from `auth`, and applying whatever that says: a
  // server can want an API key header and an OAuth sign-in both.
  const lifted = liftedFields(server, deps);
  const kind = cfg.auth?.kind ?? 'none';

  if (kind === 'oauth') {
    return {
      ...lifted,
      authProvider: new FleetOAuthProvider({
        server,
        secrets: deps.secrets,
        // No flow is running, so nothing is listening here. The URL is still the
        // one the registration was made under, which is what the token endpoint
        // checks a refresh against.
        redirectUrl: DEFAULT_CALLBACK_URL,
        openExternal: deps.openExternal
      })
    };
  }

  const token = kind === 'bearer' ? deps.secrets.getToken(server) : null;
  if (token !== null) {
    return { ...lifted, headers: { ...lifted.headers, Authorization: `Bearer ${token}` } };
  }

  // Nothing at all rather than an empty object, so a server that needs no
  // credentials is not handed one.
  return lifted.headers === undefined && lifted.env === undefined ? undefined : lifted;
}

/**
 * The secrets taken out of this server's config, back in the shape they came
 * from: `headers.X-Api-Key` becomes a header, `env.API_KEY` an environment
 * value.
 */
function liftedFields(server: string, deps: AuthDeps): TransportAuth {
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};

  for (const [field, value] of Object.entries(deps.secrets.fields(server))) {
    const [kind, ...rest] = field.split('.');
    const key = rest.join('.');
    if (key === '') continue;
    if (kind === 'headers') headers[key] = value;
    if (kind === 'env') env[key] = value;
  }

  return {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    env: Object.keys(env).length > 0 ? env : undefined
  };
}

/**
 * Sign in to one server, end to end.
 *
 * The order matters: the listener opens before the browser does, so a fast
 * authorization server cannot come back before there is anything to come back
 * to. The transport built here is thrown away afterwards whatever happens - one
 * that has been started cannot be started again, so reconnecting is the
 * manager's job on a transport of its own.
 */
export async function signIn(
  server: string,
  cfg: McpServerConfig,
  deps: AuthDeps,
  signal?: AbortSignal
): Promise<void> {
  if (transportOf(cfg) !== 'http') {
    throw new Error('Only a server reached over HTTP can be signed in to.');
  }

  const callback = await startCallback(signal);
  try {
    const provider = new FleetOAuthProvider({
      server,
      secrets: deps.secrets,
      redirectUrl: callback.redirectUrl,
      openExternal: deps.openExternal
    });

    if (await alreadyAuthorized(cfg, provider)) return;

    const params = await callback.wait();

    const failure = params.get('error');
    if (failure !== null) {
      throw new Error(params.get('error_description') ?? `The sign-in was refused: ${failure}.`);
    }

    // Checked here because the SDK does not check it and says so. Without this
    // there is nothing stopping a code the user never asked for from being
    // exchanged, which is the whole of CSRF against an OAuth client.
    if (!provider.matchesState(params.get('state') ?? undefined)) {
      throw new Error('The sign-in came back from somewhere this one did not send it.');
    }

    // A transport of its own, because the one that opened the browser has been
    // started and cannot be started again. It shares the provider, so the
    // exchange lands in the store the reconnect will read from.
    const exchange = httpTransport(cfg, { authProvider: provider });
    try {
      await exchange.finishAuth(params);
    } finally {
      await exchange.close().catch(() => {});
    }

    log.info('signed in', { server });
  } finally {
    // However this ended - signed in, refused, cancelled, thrown - nothing is
    // left listening. A port that stays open is a port anything on this machine
    // can post an authorization code to.
    callback.close();
  }
}

/**
 * Try to connect, and say whether it turned out there was nothing to do.
 *
 * A real connection rather than `transport.start()`, which for Streamable HTTP
 * only allocates an abort controller and would report success against a server
 * that has never heard of us. The 401 comes back on the first request, which is
 * the handshake, so connecting is the only thing that reaches the seam.
 *
 * What happens at that seam is the sign-in: the SDK discovers the authorization
 * server, registers if it has to, opens the browser through the provider, and
 * then reports that it could not authorize yet. So `UnauthorizedError` here is
 * the expected outcome and means a redirect is on its way. A server that
 * answers straight away - a stored token still good, a refresh that worked -
 * connects instead, and then there is nothing to wait for.
 */
async function alreadyAuthorized(
  cfg: McpServerConfig,
  provider: FleetOAuthProvider
): Promise<boolean> {
  const client = new Client({ name: 'Fleet', version: '1.0.0' });
  try {
    await client.connect(httpTransport(cfg, { authProvider: provider }));
    return true;
  } catch (err) {
    if (err instanceof UnauthorizedError) return false;
    throw err;
  } finally {
    // Thrown away either way. A connection made to find out whether we are
    // signed in is not the one the manager will run tools over.
    await client.close().catch(() => {});
  }
}
