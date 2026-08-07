import { randomBytes } from 'node:crypto';
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from '@modelcontextprotocol/client';
import type { AgentMcpSecrets } from './secrets';
import { CALLBACK_URLS } from './callback';

/**
 * Fleet signing in to one MCP server.
 *
 * The SDK drives the flow - discovery, registration, the code exchange, the
 * refresh - and asks this for the two things it cannot know: where to put
 * something so it is still there next time, and how to get a browser open.
 *
 * One instance per server per flow. Tokens and client registrations outlive it
 * in the secret store; the code verifier and the discovery cache do not, and
 * are deliberately held in memory only. The verifier has to survive the trip
 * out to the browser and back, which it does because the app stays running for
 * it, and writing a PKCE secret to disk to survive something that never happens
 * is a secret at rest for no reason.
 */

/** Where a redirect with no issuer to attribute it to is filed. */
const UNKNOWN_ISSUER = 'unknown';

export type ProviderDeps = {
  /** The server this is signing in to, which is what credentials are keyed by. */
  server: string;
  secrets: AgentMcpSecrets;
  /** Where the browser will come back to. Registered with the server, so fixed. */
  redirectUrl: string;
  /** Open a URL in the user's own browser. `shell.openExternal` in the app. */
  openExternal: (url: string) => Promise<void>;
};

export class FleetOAuthProvider implements OAuthClientProvider {
  /** The PKCE verifier for the flow in progress. */
  private verifier: string | null = null;

  /** The `state` this flow sent, to check against the one that comes back. */
  private sentState: string | null = null;

  /** Discovery, cached for as long as this provider lives. */
  private discovery: OAuthDiscoveryState | undefined;

  constructor(private readonly deps: ProviderDeps) {}

  get redirectUrl(): string {
    return this.deps.redirectUrl;
  }

  /**
   * What Fleet tells an authorization server about itself when registering.
   *
   * `native` rather than `web`, which is what makes a loopback redirect
   * acceptable: a web client redirecting to `127.0.0.1` is a red flag, and a
   * native one is the documented arrangement.
   *
   * No `client_secret` is asked for. A secret shipped inside a desktop app is
   * not a secret, and PKCE is what actually protects the exchange.
   */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Fleet',
      redirect_uris: [...CALLBACK_URLS],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native'
    };
  }

  /**
   * A fresh nonce per authorization, remembered so the redirect can be checked
   * against it.
   *
   * The SDK generates and sends this but never verifies what comes back, so
   * without the check on this side there is nothing stopping a code the user
   * did not ask for from being exchanged - which is the whole of CSRF against
   * an OAuth client. See `matchesState`.
   */
  state(): string {
    this.sentState = randomBytes(32).toString('base64url');
    return this.sentState;
  }

  /** Whether a redirect belongs to the flow this provider started. */
  matchesState(returned: string | undefined): boolean {
    // Compared, not merely present: a flow that never sent one has nothing to
    // match, and accepting the redirect anyway would defeat the point.
    return this.sentState !== null && returned === this.sentState;
  }

  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    const stored = this.deps.secrets.client(this.deps.server, ctx?.issuer ?? UNKNOWN_ISSUER);
    return stored ?? undefined;
  }

  saveClientInformation(
    info: StoredOAuthClientInformation,
    ctx?: OAuthClientInformationContext
  ): void {
    this.deps.secrets.saveClient(this.deps.server, issuerOf(info, ctx), info);
  }

  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.deps.secrets.tokens(this.deps.server, ctx?.issuer) ?? undefined;
  }

  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    this.deps.secrets.saveTokens(this.deps.server, issuerOf(tokens, ctx), tokens);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // The user's own browser, not a window inside Fleet. They may already be
    // signed in to the provider there, they can see the address bar, and a
    // password manager they trust is the one that fills it in.
    await this.deps.openExternal(authorizationUrl.toString());
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (this.verifier === null) {
      throw new Error('There is no sign-in in progress for this server.');
    }
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  /**
   * Throw away what the server says is no longer good.
   *
   * `verifier` and `discovery` are in memory, so this is the only thing that
   * clears them - nothing expires them on its own.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'verifier' || scope === 'all') this.verifier = null;
    if (scope === 'discovery' || scope === 'all') this.discovery = undefined;
    if (scope === 'all') this.deps.secrets.invalidate(this.deps.server, 'all');
    if (scope === 'client') this.deps.secrets.invalidate(this.deps.server, 'client');
    if (scope === 'tokens') this.deps.secrets.invalidate(this.deps.server, 'tokens');
  }
}

/**
 * Which authorization server a credential belongs to.
 *
 * The stamp on the value itself is preferred over the context: SEP-2352 puts it
 * there precisely so a credential carries its own binding, and the context is
 * the older way of saying the same thing.
 */
function issuerOf(value: { issuer?: string }, ctx?: OAuthClientInformationContext): string {
  return value.issuer ?? ctx?.issuer ?? UNKNOWN_ISSUER;
}
