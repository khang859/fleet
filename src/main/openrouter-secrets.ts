import Store from 'electron-store';
import { safeStorage } from 'electron';

/**
 * The OpenRouter API key, encrypted at rest.
 *
 * App-wide rather than owned by whatever feature happens to call the API: the
 * key is the user's account, not one pane's setting. The store file is still
 * named `fleet-chat-secrets` because that is where existing installs wrote it,
 * and renaming it would silently ask everyone to type their key again.
 */

type SecretsData = {
  keyEnc?: string;
};

interface KeyStore {
  get(): SecretsData;
  set(next: SecretsData): void;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

type Options = { store?: KeyStore; safeStorage?: SafeStorageLike };

function defaultStore(): KeyStore {
  // Opened on first read or write. `conf`, underneath `electron-store`, writes
  // its file atomically as part of construction - a blocking fsync - and this
  // store is built during startup for a key most launches never ask for.
  let store: Store<{ data: SecretsData }> | null = null;
  const open = (): Store<{ data: SecretsData }> =>
    (store ??= new Store<{ data: SecretsData }>({
      name: 'fleet-chat-secrets',
      defaults: { data: {} }
    }));
  return {
    get: () => open().get('data'),
    set: (next) => open().set('data', next)
  };
}

export class OpenRouterSecrets {
  private readonly store: KeyStore;
  private readonly safe: SafeStorageLike;

  constructor(opts: Options = {}) {
    this.store = opts.store ?? defaultStore();
    this.safe = opts.safeStorage ?? safeStorage;
  }

  isEncryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }

  setKey(plain: string): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }
    const enc = this.safe.encryptString(plain).toString('base64');
    this.store.set({ keyEnc: enc });
  }

  getKey(): string | null {
    const { keyEnc } = this.store.get();
    if (!keyEnc) return null;
    try {
      return this.safe.decryptString(Buffer.from(keyEnc, 'base64'));
    } catch {
      return null;
    }
  }

  hasKey(): boolean {
    return Boolean(this.store.get().keyEnc);
  }

  clearKey(): void {
    this.store.set({ ...this.store.get(), keyEnc: undefined });
  }
}
