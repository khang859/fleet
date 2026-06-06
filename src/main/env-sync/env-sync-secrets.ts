import Store from 'electron-store';
import { safeStorage } from 'electron';
import type {
  RedactedEnvSyncSecrets,
  RedactedEnvSyncAuth,
  EnvSyncAuthInput,
  EnvSyncAuthResolved
} from '../../shared/env-sync-types';

/** Persisted auth entry. Key material is safeStorage-encrypted base64; profile/mode are plaintext. */
export type StoredAuth = {
  mode: EnvSyncAuthResolved['mode'];
  profile?: string;
  accessKeyIdEnc?: string;
  secretAccessKeyEnc?: string;
  sessionTokenEnc?: string;
};

export type EnvSyncSecretsData = {
  globalPassphraseEnc?: string;
  repoOverrides: Record<string, { passphraseEnc?: string }>;
  globalAuth?: StoredAuth;
  authRepoOverrides?: Record<string, StoredAuth>;
};

interface SecretsStore {
  get(): EnvSyncSecretsData;
  set(next: EnvSyncSecretsData): void;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

type Options = { store?: SecretsStore; safeStorage?: SafeStorageLike };

function defaultStore(): SecretsStore {
  const store = new Store<{ data: EnvSyncSecretsData }>({
    name: 'fleet-env-sync-secrets',
    defaults: { data: { repoOverrides: {} } }
  });
  return {
    get: () => store.get('data'),
    set: (next) => store.set('data', next)
  };
}

export class EnvSyncSecrets {
  private readonly store: SecretsStore;
  private readonly safe: SafeStorageLike;

  constructor(opts: Options = {}) {
    this.store = opts.store ?? defaultStore();
    this.safe = opts.safeStorage ?? safeStorage;
  }

  isEncryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  getRedacted(): RedactedEnvSyncSecrets {
    const raw = this.store.get();
    const repoOverrides: Record<string, { present: boolean }> = {};
    for (const [id, v] of Object.entries(raw.repoOverrides ?? {})) {
      repoOverrides[id] = { present: Boolean(v.passphraseEnc) };
    }
    const authRepoOverrides: Record<string, RedactedEnvSyncAuth> = {};
    for (const [id, v] of Object.entries(raw.authRepoOverrides ?? {})) {
      const r = this.redactAuth(v);
      if (r) authRepoOverrides[id] = r;
    }
    return {
      globalPresent: Boolean(raw.globalPassphraseEnc),
      repoOverrides,
      globalAuth: this.redactAuth(raw.globalAuth),
      authRepoOverrides
    };
  }

  setGlobalPassphrase(plain: string): void {
    this.assertEncryption();
    const raw = this.store.get();
    this.store.set({ ...raw, globalPassphraseEnc: this.encode(plain) });
  }

  clearGlobalPassphrase(): void {
    const raw = this.store.get();
    this.store.set({ ...raw, globalPassphraseEnc: undefined });
  }

  setRepoPassphrase(id: string, plain: string): void {
    this.assertEncryption();
    const raw = this.store.get();
    this.store.set({
      ...raw,
      repoOverrides: { ...raw.repoOverrides, [id]: { passphraseEnc: this.encode(plain) } }
    });
  }

  clearRepoPassphrase(id: string): void {
    const raw = this.store.get();
    const next = { ...raw.repoOverrides };
    delete next[id];
    this.store.set({ ...raw, repoOverrides: next });
  }

  /** Main-process only. Throws if none configured. */
  resolvePassphrase(id: string): string {
    const raw = this.store.get();
    const override = raw.repoOverrides?.[id]?.passphraseEnc;
    const enc = override ?? raw.globalPassphraseEnc;
    if (!enc) throw new Error(`No passphrase configured for repo "${id}"`);
    return this.decode(enc);
  }

  setGlobalAuth(input: EnvSyncAuthInput): void {
    const raw = this.store.get();
    this.store.set({ ...raw, globalAuth: this.encodeAuth(input) });
  }

  clearGlobalAuth(): void {
    const raw = this.store.get();
    this.store.set({ ...raw, globalAuth: undefined });
  }

  setRepoAuth(id: string, input: EnvSyncAuthInput): void {
    const raw = this.store.get();
    this.store.set({
      ...raw,
      authRepoOverrides: { ...(raw.authRepoOverrides ?? {}), [id]: this.encodeAuth(input) }
    });
  }

  clearRepoAuth(id: string): void {
    const raw = this.store.get();
    const next = { ...(raw.authRepoOverrides ?? {}) };
    delete next[id];
    this.store.set({ ...raw, authRepoOverrides: next });
  }

  /** Main-process only. Per-repo override → global → implicit default-chain. Decrypts static keys. */
  resolveAuth(id: string): EnvSyncAuthResolved {
    const raw = this.store.get();
    const stored = raw.authRepoOverrides?.[id] ?? raw.globalAuth;
    if (!stored) return { mode: 'default-chain' };
    const resolved: EnvSyncAuthResolved = { mode: stored.mode, profile: stored.profile };
    if (stored.mode === 'static') {
      if (stored.accessKeyIdEnc) resolved.accessKeyId = this.decode(stored.accessKeyIdEnc);
      if (stored.secretAccessKeyEnc)
        resolved.secretAccessKey = this.decode(stored.secretAccessKeyEnc);
      if (stored.sessionTokenEnc) resolved.sessionToken = this.decode(stored.sessionTokenEnc);
    }
    return resolved;
  }

  /** Encrypt only when there is secret key material; profile/default-chain need no keychain. */
  private encodeAuth(input: EnvSyncAuthInput): StoredAuth {
    const stored: StoredAuth = { mode: input.mode, profile: input.profile };
    if (input.mode === 'static') {
      this.assertEncryption();
      if (input.accessKeyId) stored.accessKeyIdEnc = this.encode(input.accessKeyId);
      if (input.secretAccessKey) stored.secretAccessKeyEnc = this.encode(input.secretAccessKey);
      if (input.sessionToken) stored.sessionTokenEnc = this.encode(input.sessionToken);
    }
    return stored;
  }

  private redactAuth(stored: StoredAuth | undefined): RedactedEnvSyncAuth | undefined {
    if (!stored) return undefined;
    return {
      mode: stored.mode,
      profile: stored.profile,
      hasAccessKeyId: Boolean(stored.accessKeyIdEnc),
      hasSecretAccessKey: Boolean(stored.secretAccessKeyEnc),
      hasSessionToken: Boolean(stored.sessionTokenEnc)
    };
  }

  private encode(plain: string): string {
    return this.safe.encryptString(plain).toString('base64');
  }

  private decode(enc: string): string {
    return this.safe.decryptString(Buffer.from(enc, 'base64'));
  }

  private assertEncryption(): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('OS keychain encryption is unavailable; cannot store secret.');
    }
  }
}
