import Store from 'electron-store';
import { safeStorage } from 'electron';
import { z } from 'zod';

/**
 * What the Agent pane's MCP servers need to prove who we are.
 *
 * Kept out of `fleet-settings.json` entirely. That file is plain text, it is
 * the thing a user opens to check a setting, and it is the thing they paste
 * into an issue when something is wrong - none of which should ever have put a
 * token in front of them. Everything here goes through `safeStorage`, so it is
 * encrypted with a key held by the OS keychain rather than by Fleet.
 *
 * Keyed by server name, and within a server by the authorization server that
 * issued the credential: a client id is unique to the authorization server that
 * handed it out, and a server whose `authorization_servers` list changes must
 * not be handed the old one back.
 */

const OAuthTokens = z.looseObject({
  access_token: z.string(),
  token_type: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
  issuer: z.string().optional()
});

const ClientInformation = z.looseObject({
  client_id: z.string(),
  client_secret: z.string().optional(),
  issuer: z.string().optional()
});

export type StoredTokens = z.infer<typeof OAuthTokens>;
export type StoredClient = z.infer<typeof ClientInformation>;

/** What a server's credentials look like once decrypted. `Enc` is base64 ciphertext. */
type ServerSecrets = {
  /** A static token the user typed, for a server that just wants a header. */
  tokenEnc?: string;
  /** OAuth tokens, by issuer. */
  oauthEnc?: Record<string, string>;
  /** Client registration, by issuer. */
  clientEnc?: Record<string, string>;
  /**
   * Header and environment values lifted out of the config, by field.
   *
   * Keyed `headers.<name>` or `env.<name>`, so one server can hold several -
   * an API key header and a token in the environment are both ordinary.
   */
  fieldsEnc?: Record<string, string>;
  /**
   * The issuer the last token was saved under.
   *
   * The transport reads the bearer token for each request without saying which
   * authorization server it means, and answering `undefined` there would send
   * the request unauthenticated. So the most recent one is remembered.
   */
  lastIssuer?: string;
};

type SecretsData = Record<string, ServerSecrets | undefined>;

interface SecretStore {
  get(): SecretsData;
  set(next: SecretsData): void;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export type Options = { store?: SecretStore; safeStorage?: SafeStorageLike };

function defaultStore(): SecretStore {
  const store = new Store<{ data: SecretsData }>({
    name: 'fleet-agent-mcp-secrets',
    defaults: { data: {} }
  });
  return {
    get: () => store.get('data'),
    set: (next) => store.set('data', next)
  };
}

/** What "all" means when credentials are thrown away. */
export type SecretScope = 'all' | 'client' | 'tokens';

export class AgentMcpSecrets {
  private readonly store: SecretStore;
  private readonly safe: SafeStorageLike;

  constructor(opts: Options = {}) {
    this.store = opts.store ?? defaultStore();
    this.safe = opts.safeStorage ?? safeStorage;
  }

  isEncryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  /** A static token, for a server the user authenticates by hand. */
  setToken(server: string, plain: string): void {
    this.update(server, (s) => ({ ...s, tokenEnc: this.encrypt(plain) }));
  }

  getToken(server: string): string | null {
    return this.decrypt(this.of(server).tokenEnc);
  }

  hasToken(server: string): boolean {
    return this.of(server).tokenEnc !== undefined;
  }

  clearToken(server: string): void {
    this.update(server, (s) => {
      const next = { ...s };
      delete next.tokenEnc;
      return next;
    });
  }

  /**
   * A header or environment value lifted out of the config.
   *
   * `field` is `headers.<name>` or `env.<name>` - the same path the config
   * leaves a reference at, so the two line up without anything having to be
   * remembered alongside.
   */
  setField(server: string, field: string, plain: string): void {
    this.update(server, (s) => ({
      ...s,
      fieldsEnc: { ...s.fieldsEnc, [field]: this.encrypt(plain) }
    }));
  }

  /** Every lifted field for one server, decrypted. Ones that will not decrypt are left out. */
  fields(server: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [field, enc] of Object.entries(this.of(server).fieldsEnc ?? {})) {
      const value = this.decrypt(enc);
      if (value !== null) out[field] = value;
    }
    return out;
  }

  saveTokens(server: string, issuer: string, tokens: StoredTokens): void {
    this.update(server, (s) => ({
      ...s,
      oauthEnc: { ...s.oauthEnc, [issuer]: this.encrypt(JSON.stringify(tokens)) },
      lastIssuer: issuer
    }));
  }

  /**
   * The tokens for one authorization server, or the most recent set when the
   * caller did not say which - which is how the transport asks for a bearer
   * token before any request.
   */
  tokens(server: string, issuer?: string): StoredTokens | null {
    const entry = this.of(server);
    const key = issuer ?? entry.lastIssuer;
    if (key === undefined) return null;
    return parse(OAuthTokens, this.decrypt(entry.oauthEnc?.[key]));
  }

  saveClient(server: string, issuer: string, client: StoredClient): void {
    this.update(server, (s) => ({
      ...s,
      clientEnc: { ...s.clientEnc, [issuer]: this.encrypt(JSON.stringify(client)) }
    }));
  }

  client(server: string, issuer: string): StoredClient | null {
    return parse(ClientInformation, this.decrypt(this.of(server).clientEnc?.[issuer]));
  }

  /** Whether this server has ever finished a sign-in. */
  isSignedIn(server: string): boolean {
    return this.tokens(server) !== null;
  }

  /**
   * Throw credentials away, as the SDK asks when a server says they are no
   * longer good. Everything for that server, rather than the one issuer: a
   * server that stopped recognising us is one to start over with.
   */
  invalidate(server: string, scope: SecretScope): void {
    this.update(server, (s) => {
      if (scope === 'all') return {};
      if (scope === 'client') return { ...s, clientEnc: undefined };
      return { ...s, oauthEnc: undefined, lastIssuer: undefined };
    });
  }

  /** Forget a server entirely, for when the user removes it. */
  forget(server: string): void {
    const data = { ...this.store.get() };
    delete data[server];
    this.store.set(data);
  }

  /**
   * Move a server's credentials when it is renamed.
   *
   * Without this a rename silently signs the user out, which looks like the
   * server breaking rather than like the rename doing anything.
   */
  rename(from: string, to: string): void {
    const data = { ...this.store.get() };
    const entry = data[from];
    if (entry === undefined) return;
    delete data[from];
    data[to] = entry;
    this.store.set(data);
  }

  private of(server: string): ServerSecrets {
    return this.store.get()[server] ?? {};
  }

  private update(server: string, change: (current: ServerSecrets) => ServerSecrets): void {
    const data = this.store.get();
    this.store.set({ ...data, [server]: change(data[server] ?? {}) });
  }

  private encrypt(plain: string): string {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }
    return this.safe.encryptString(plain).toString('base64');
  }

  /**
   * `null` rather than a throw on anything unreadable.
   *
   * Ciphertext written under a keychain entry that is gone - a restored
   * machine, a new user - cannot be recovered, and the right answer to that is
   * to be signed out and able to sign in again, not to have a pane that will
   * not open.
   */
  private decrypt(enc: string | undefined): string | null {
    if (enc === undefined) return null;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }
}

function parse<T>(schema: z.ZodType<T>, json: string | null): T | null {
  if (json === null) return null;
  try {
    const result = schema.safeParse(JSON.parse(json));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
