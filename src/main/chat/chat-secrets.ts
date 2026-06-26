import Store from 'electron-store';
import { safeStorage } from 'electron';

type SecretsData = { keyEnc?: string; searchKeyEnc?: string };

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

  /** Web-search provider API key — a separate encrypted slot from the chat key. */
  setSearchKey(plain: string): void {
    if (!this.safe.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }
    const enc = this.safe.encryptString(plain).toString('base64');
    this.store.set({ ...this.store.get(), searchKeyEnc: enc });
  }

  getSearchKey(): string | null {
    const { searchKeyEnc } = this.store.get();
    if (!searchKeyEnc) return null;
    try {
      return this.safe.decryptString(Buffer.from(searchKeyEnc, 'base64'));
    } catch {
      return null;
    }
  }

  hasSearchKey(): boolean {
    return Boolean(this.store.get().searchKeyEnc);
  }
}
