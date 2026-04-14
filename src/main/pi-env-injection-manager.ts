import Store from 'electron-store';
import { safeStorage } from 'electron';
import {
  PiEnvInjectionSchema,
  type PiEnvInjection,
  type PiBedrockInjection,
  type RedactedBedrock,
  type BedrockWritePatch
} from '../shared/pi-env-injection-types';
import { createLogger } from './logger';

const log = createLogger('pi-env-injection');

export type { BedrockWritePatch };

interface EnvInjectionStore {
  get(): PiEnvInjection;
  set(next: PiEnvInjection): void;
}

interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

type PiEnvInjectionManagerOptions = {
  store?: EnvInjectionStore;
  safeStorage?: SafeStorageLike;
};

function defaultStore(): EnvInjectionStore {
  const store = new Store<{ data: PiEnvInjection }>({
    name: 'fleet-pi-env-injection',
    defaults: { data: {} }
  });
  return {
    get: () => store.get('data'),
    set: (next) => store.set('data', next)
  };
}

export class PiEnvInjectionManager {
  private readonly store: EnvInjectionStore;
  private readonly safe: SafeStorageLike;

  constructor(opts: PiEnvInjectionManagerOptions = {}) {
    this.store = opts.store ?? defaultStore();
    this.safe = opts.safeStorage ?? safeStorage;
  }

  getRedactedConfig(): { bedrock?: RedactedBedrock } {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    if (!raw.bedrock) return {};
    return {
      bedrock: {
        mode: raw.bedrock.mode,
        region: raw.bedrock.region,
        profile: raw.bedrock.profile,
        accessKeyId: raw.bedrock.accessKeyId,
        secretAccessKeyPresent: Boolean(raw.bedrock.secretAccessKeyEnc),
        sessionTokenPresent: Boolean(raw.bedrock.sessionTokenEnc)
      }
    };
  }

  writeBedrock(patch: BedrockWritePatch): void {
    const suppliesSecret =
      (patch.secretAccessKey !== undefined && patch.secretAccessKey !== '') ||
      (patch.sessionToken !== undefined && patch.sessionToken !== '');
    if (suppliesSecret && !this.safe.isEncryptionAvailable()) {
      throw new Error('OS keychain encryption is unavailable; cannot store AWS secret.');
    }

    const raw = PiEnvInjectionSchema.parse(this.store.get());
    const current: PiBedrockInjection = raw.bedrock ?? { mode: 'chain' };

    const next: PiBedrockInjection = {
      mode: patch.mode ?? current.mode,
      region: patch.region !== undefined ? patch.region || undefined : current.region,
      profile: patch.profile !== undefined ? patch.profile || undefined : current.profile,
      accessKeyId:
        patch.accessKeyId !== undefined ? patch.accessKeyId || undefined : current.accessKeyId,
      secretAccessKeyEnc: current.secretAccessKeyEnc,
      sessionTokenEnc: current.sessionTokenEnc
    };

    if (patch.secretAccessKey !== undefined) {
      next.secretAccessKeyEnc =
        patch.secretAccessKey === ''
          ? undefined
          : this.safe.encryptString(patch.secretAccessKey).toString('base64');
    }
    if (patch.sessionToken !== undefined) {
      next.sessionTokenEnc =
        patch.sessionToken === ''
          ? undefined
          : this.safe.encryptString(patch.sessionToken).toString('base64');
    }

    this.store.set({ ...raw, bedrock: next });
  }

  clearBedrockSecret(field: 'secretAccessKey' | 'sessionToken'): void {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    if (!raw.bedrock) return;
    const next: PiBedrockInjection = { ...raw.bedrock };
    if (field === 'secretAccessKey') next.secretAccessKeyEnc = undefined;
    if (field === 'sessionToken') next.sessionTokenEnc = undefined;
    this.store.set({ ...raw, bedrock: next });
  }

  /** Main-process only. Decrypts on demand; skips fields that fail to decrypt. */
  getInjectedEnv(): Record<string, string> {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    const out: Record<string, string> = {};
    const b = raw.bedrock;
    if (!b) return out;

    if (b.region) out.AWS_REGION = b.region;

    if (b.mode === 'profile') {
      if (b.profile) out.AWS_PROFILE = b.profile;
    } else if (b.mode === 'keys') {
      if (b.accessKeyId) out.AWS_ACCESS_KEY_ID = b.accessKeyId;
      if (b.secretAccessKeyEnc) {
        try {
          out.AWS_SECRET_ACCESS_KEY = this.safe.decryptString(
            Buffer.from(b.secretAccessKeyEnc, 'base64')
          );
        } catch (err) {
          log.warn('Failed to decrypt AWS_SECRET_ACCESS_KEY; skipping', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
      if (b.sessionTokenEnc) {
        try {
          out.AWS_SESSION_TOKEN = this.safe.decryptString(Buffer.from(b.sessionTokenEnc, 'base64'));
        } catch (err) {
          log.warn('Failed to decrypt AWS_SESSION_TOKEN; skipping', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }

    return out;
  }

  isEncryptionAvailable(): boolean {
    return this.safe.isEncryptionAvailable();
  }
}
