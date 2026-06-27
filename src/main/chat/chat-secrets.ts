import Store from 'electron-store';
import { safeStorage } from 'electron';
import type { WebSearchProviderId } from '../../shared/chat-types';

type SecretsData = {
  keyEnc?: string;
  /** Legacy single search key — read as the Tavily key for backward compat. */
  searchKeyEnc?: string;
  /** Per-provider encrypted search keys, so switching providers keeps each intact. */
  searchKeysEnc?: Partial<Record<WebSearchProviderId, string>>;
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
  const store = new Store<{ data: SecretsData }>({
    name: 'fleet-chat-secrets',
    defaults: { data: {} }
  });
  return {
    get: () => store.get('data'),
    set: (next) => store.set('data', next)
  };
}

export class ChatSecrets {
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

  /** Web-search provider API key — one encrypted slot per provider, separate from the chat key. */
  setSearchKey(provider: WebSearchProviderId, plain: string): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }
    const enc = this.safe.encryptString(plain).toString('base64');
    const data = this.store.get();
    this.store.set({ ...data, searchKeysEnc: { ...data.searchKeysEnc, [provider]: enc } });
  }

  getSearchKey(provider: WebSearchProviderId): string | null {
    const enc = this.searchKeyEnc(provider);
    if (!enc) return null;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  hasSearchKey(provider: WebSearchProviderId): boolean {
    return Boolean(this.searchKeyEnc(provider));
  }

  clearSearchKey(provider: WebSearchProviderId): void {
    const data = this.store.get();
    const next = { ...data.searchKeysEnc };
    delete next[provider];
    // Also drop the legacy single-slot key so removing Tavily fully clears it.
    const searchKeyEnc = provider === 'tavily' ? undefined : data.searchKeyEnc;
    this.store.set({ ...data, searchKeysEnc: next, searchKeyEnc });
  }

  /** The stored ciphertext for a provider; falls back to the legacy slot for Tavily. */
  private searchKeyEnc(provider: WebSearchProviderId): string | undefined {
    const data = this.store.get();
    return (
      data.searchKeysEnc?.[provider] ?? (provider === 'tavily' ? data.searchKeyEnc : undefined)
    );
  }
}
