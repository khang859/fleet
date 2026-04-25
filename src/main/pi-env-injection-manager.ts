import Store from 'electron-store';
import { safeStorage } from 'electron';
import {
  PiEnvInjectionSchema,
  type PiEnvInjection,
  type PiBedrockInjection,
  type RedactedBedrock,
  type BedrockWritePatch,
  type BedrockSecretField
} from '../shared/pi-env-injection-types';
import { createLogger } from './logger';

const log = createLogger('pi-env-injection');

export type { BedrockWritePatch };

export type InjectedEnv = {
  set: Record<string, string>;
  unset: string[];
};

const PROFILE_MODE_UNSETS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK'
];
const KEYS_MODE_UNSETS = ['AWS_PROFILE', 'AWS_BEARER_TOKEN_BEDROCK'];
const BEARER_MODE_UNSETS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN'
];

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
    const bedrock: RedactedBedrock = {
      mode: raw.bedrock.mode,
      secretAccessKeyPresent: Boolean(raw.bedrock.secretAccessKeyEnc),
      sessionTokenPresent: Boolean(raw.bedrock.sessionTokenEnc),
      bearerTokenPresent: Boolean(raw.bedrock.bearerTokenEnc)
    };
    if (raw.bedrock.region) bedrock.region = raw.bedrock.region;
    if (raw.bedrock.profile) bedrock.profile = raw.bedrock.profile;
    if (raw.bedrock.accessKeyId) bedrock.accessKeyId = raw.bedrock.accessKeyId;
    return {
      bedrock
    };
  }

  writeBedrock(patch: BedrockWritePatch): void {
    const suppliesSecret =
      (patch.secretAccessKey !== undefined && patch.secretAccessKey !== '') ||
      (patch.sessionToken !== undefined && patch.sessionToken !== '') ||
      (patch.bearerToken !== undefined && patch.bearerToken !== '');
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
      sessionTokenEnc: current.sessionTokenEnc,
      bearerTokenEnc: current.bearerTokenEnc
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
    if (patch.bearerToken !== undefined) {
      next.bearerTokenEnc =
        patch.bearerToken === ''
          ? undefined
          : this.safe.encryptString(patch.bearerToken).toString('base64');
    }

    this.store.set({ ...raw, bedrock: next });
  }

  clearBedrockSecret(field: BedrockSecretField): void {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    if (!raw.bedrock) return;
    const next: PiBedrockInjection = { ...raw.bedrock };
    if (field === 'secretAccessKey') next.secretAccessKeyEnc = undefined;
    if (field === 'sessionToken') next.sessionTokenEnc = undefined;
    if (field === 'bearerToken') next.bearerTokenEnc = undefined;
    this.store.set({ ...raw, bedrock: next });
  }

  /** Main-process only. Decrypts on demand; skips fields that fail to decrypt. */
  getInjectedEnv(): InjectedEnv {
    const raw = PiEnvInjectionSchema.parse(this.store.get());
    const out: InjectedEnv = { set: {}, unset: [] };
    const b = raw.bedrock;
    if (!b) return out;

    if (b.region) out.set.AWS_REGION = b.region;

    if (b.mode === 'profile') {
      out.unset = PROFILE_MODE_UNSETS;
      if (b.profile) out.set.AWS_PROFILE = b.profile;
    } else if (b.mode === 'keys') {
      out.unset = KEYS_MODE_UNSETS;
      if (b.accessKeyId) out.set.AWS_ACCESS_KEY_ID = b.accessKeyId;
      if (b.secretAccessKeyEnc) {
        try {
          out.set.AWS_SECRET_ACCESS_KEY = this.safe.decryptString(
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
          out.set.AWS_SESSION_TOKEN = this.safe.decryptString(
            Buffer.from(b.sessionTokenEnc, 'base64')
          );
        } catch (err) {
          log.warn('Failed to decrypt AWS_SESSION_TOKEN; skipping', {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    } else if (b.mode === 'bearer') {
      out.unset = BEARER_MODE_UNSETS;
      if (b.bearerTokenEnc) {
        try {
          out.set.AWS_BEARER_TOKEN_BEDROCK = this.safe.decryptString(
            Buffer.from(b.bearerTokenEnc, 'base64')
          );
        } catch (err) {
          log.warn('Failed to decrypt AWS_BEARER_TOKEN_BEDROCK; skipping', {
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
