// src/main/env-sync/env-sync-manager.ts
import Store from 'electron-store';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  readConfig,
  resolveObjectKey,
  resolveBucketRegion,
  findNearestConfig,
  mostSpecificInjectTarget,
  configPath
} from './env-sync-config';
import { diffEnv, hashPlaintext, parseEnv } from './env-file';
import * as realS3 from './s3-client';
import * as realCrypto from './env-sync-crypto';
import type {
  EnvSyncConfig,
  EnvSyncTarget,
  TargetStatus,
  SyncOutcome,
  EnvSyncAuthResolved
} from '../../shared/env-sync-types';

export type SyncStateEntry = { lastEtag: string; lastPlaintextHash: string; lastSyncedAt: number };
export type EnvSyncSyncStateData = Record<string, SyncStateEntry>;

interface StateStore {
  get(): EnvSyncSyncStateData;
  set(next: EnvSyncSyncStateData): void;
}

interface S3Like {
  head: typeof realS3.head;
  get: typeof realS3.get;
  put: typeof realS3.put;
  isPreconditionFailed: typeof realS3.isPreconditionFailed;
  isConditionalConflict: typeof realS3.isConditionalConflict;
}
interface CryptoLike {
  encrypt: (pt: Buffer, passphrase: string) => Promise<Buffer>;
  decrypt: (blob: Buffer, passphrase: string) => Promise<Buffer>;
}
interface SecretsLike {
  resolvePassphrase: (id: string) => string;
  resolveAuth: (id: string) => EnvSyncAuthResolved;
}

type Options = { s3?: S3Like; crypto?: CryptoLike; secrets: SecretsLike; store?: StateStore };

function defaultStore(): StateStore {
  const store = new Store<{ data: EnvSyncSyncStateData }>({
    name: 'fleet-env-sync-state',
    defaults: { data: {} }
  });
  return { get: () => store.get('data'), set: (next) => store.set('data', next) };
}

export class EnvSyncManager {
  private readonly s3: S3Like;
  private readonly crypto: CryptoLike;
  private readonly secrets: SecretsLike;
  private readonly store: StateStore;
  /** In-memory decrypted vars for inject delivery, keyed by `${objectKey}@${etag}`. */
  private injectCache = new Map<string, Record<string, string>>();

  constructor(opts: Options) {
    this.s3 = opts.s3 ?? realS3;
    this.crypto = opts.crypto ?? realCrypto;
    this.secrets = opts.secrets;
    this.store = opts.store ?? defaultStore();
  }

  /**
   * Drop all in-memory decrypted inject vars. Must be called whenever the
   * passphrase or AWS auth changes: the cache is keyed by `${objectKey}@${etag}`,
   * and neither a passphrase change nor an auth change moves the etag, so without
   * this the next spawn would serve secrets decrypted with the old passphrase
   * (or read with the old identity).
   */
  clearInjectCache(): void {
    this.injectCache.clear();
  }

  private stateKey(repoDir: string, objectKey: string): string {
    return `${configPath(repoDir)}::${objectKey}`;
  }

  private getState(repoDir: string, objectKey: string): SyncStateEntry | undefined {
    return this.store.get()[this.stateKey(repoDir, objectKey)];
  }

  private setState(repoDir: string, objectKey: string, entry: SyncStateEntry): void {
    const all = this.store.get();
    this.store.set({ ...all, [this.stateKey(repoDir, objectKey)]: entry });
  }

  private readLocal(repoDir: string, target: EnvSyncTarget): string | null {
    const p = join(repoDir, target.envFile);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  async status(repoDir: string): Promise<TargetStatus[]> {
    let config: EnvSyncConfig | null;
    try {
      config = readConfig(repoDir);
    } catch (err) {
      // Malformed .fleet/env-sync.json → surface as an error row instead of rejecting,
      // so the status badge can show it (spec §2). findNearestConfig still swallows to
      // null for discovery, so an invalid config is only flagged once a repoDir is known.
      return [
        {
          envFile: '.fleet/env-sync.json',
          objectKey: '',
          delivery: 'file',
          state: 'error',
          error: err instanceof Error ? err.message : String(err)
        }
      ];
    }
    if (!config) return [];
    const out: TargetStatus[] = [];
    for (const target of config.targets) {
      const objectKey = resolveObjectKey(config, target);
      const { bucket, region } = resolveBucketRegion(config, target);
      const base = { envFile: target.envFile, objectKey, delivery: target.delivery };
      try {
        // Inside the try so a keychain-locked static-key decode surfaces as an
        // error row instead of rejecting the whole status() call.
        const auth = this.secrets.resolveAuth(config.id);
        const remote = await this.s3.head(bucket, region, objectKey, auth);
        const localText = this.readLocal(repoDir, target);
        const state = this.getState(repoDir, objectKey);
        out.push({ ...base, state: this.deriveState(localText, remote?.etag, state) });
      } catch (err) {
        out.push({
          ...base,
          state: 'error',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return out;
  }

  private deriveState(
    localText: string | null,
    remoteEtag: string | undefined,
    state: SyncStateEntry | undefined
  ): TargetStatus['state'] {
    const hasRemote = remoteEtag !== undefined;
    const hasLocal = localText !== null;
    if (!hasRemote && !hasLocal) return 'no-remote-no-local';
    if (!hasRemote) return 'local-only';
    if (!hasLocal) return 'remote-only';
    const remoteChanged = remoteEtag !== state?.lastEtag;
    const localChanged = hashPlaintext(localText) !== state?.lastPlaintextHash;
    if (remoteChanged && localChanged) return 'conflict';
    if (remoteChanged) return 'remote-ahead';
    if (localChanged) return 'local-ahead';
    return 'in-sync';
  }

  async pull(
    repoDir: string,
    _resolveDir: string,
    envFile: string,
    opts: { force?: boolean } = {}
  ): Promise<SyncOutcome> {
    const config = readConfig(repoDir);
    const target = config?.targets.find((t) => t.envFile === envFile);
    if (!config || !target) return { ok: false, conflict: false, error: 'Target not found' };
    const objectKey = resolveObjectKey(config, target);
    const { bucket, region } = resolveBucketRegion(config, target);
    try {
      const passphrase = this.secrets.resolvePassphrase(config.id);
      const auth = this.secrets.resolveAuth(config.id);
      const remote = await this.s3.get(bucket, region, objectKey, auth);
      const remoteText = (await this.crypto.decrypt(remote.body, passphrase)).toString('utf8');
      const localText = this.readLocal(repoDir, target);
      const state = this.getState(repoDir, objectKey);

      if (!opts.force && localText !== null) {
        const localChanged = hashPlaintext(localText) !== state?.lastPlaintextHash;
        const remoteChanged = remote.etag !== state?.lastEtag;
        if (localChanged && remoteChanged) {
          return { ok: false, conflict: true, diff: diffEnv(localText, remoteText) };
        }
      }

      this.applyPulled(repoDir, target, remoteText, objectKey, remote.etag);
      this.setState(repoDir, objectKey, {
        lastEtag: remote.etag,
        lastPlaintextHash: hashPlaintext(remoteText),
        lastSyncedAt: Date.now()
      });
      return { ok: true, state: 'in-sync' };
    } catch (err) {
      return {
        ok: false,
        conflict: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private applyPulled(
    repoDir: string,
    target: EnvSyncTarget,
    text: string,
    objectKey: string,
    etag: string
  ): void {
    if (target.delivery === 'file') {
      const p = join(repoDir, target.envFile);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text, 'utf8');
    } else {
      this.injectCache.set(`${objectKey}@${etag}`, parseEnv(text).map);
    }
  }

  async push(
    repoDir: string,
    _resolveDir: string,
    envFile: string,
    opts: { force?: boolean } = {}
  ): Promise<SyncOutcome> {
    const config = readConfig(repoDir);
    const target = config?.targets.find((t) => t.envFile === envFile);
    if (!config || !target) return { ok: false, conflict: false, error: 'Target not found' };
    const objectKey = resolveObjectKey(config, target);
    const { bucket, region } = resolveBucketRegion(config, target);
    const localText = this.readLocal(repoDir, target);
    if (localText === null) return { ok: false, conflict: false, error: 'No local file to push' };
    try {
      const passphrase = this.secrets.resolvePassphrase(config.id);
      const auth = this.secrets.resolveAuth(config.id);
      const state = this.getState(repoDir, objectKey);
      const blob = await this.crypto.encrypt(Buffer.from(localText, 'utf8'), passphrase);
      const ifMatch = opts.force
        ? await this.currentEtag(bucket, region, objectKey, auth)
        : state?.lastEtag;
      const result = await this.s3.put(bucket, region, objectKey, blob, auth, ifMatch);
      this.setState(repoDir, objectKey, {
        lastEtag: result.etag,
        lastPlaintextHash: hashPlaintext(localText),
        lastSyncedAt: Date.now()
      });
      return { ok: true, state: 'in-sync' };
    } catch (err) {
      // 412: the remote ETag genuinely diverged → surface a conflict diff.
      if (this.s3.isPreconditionFailed(err)) {
        const remoteText = await this.safeRemoteText(bucket, region, objectKey, config.id);
        return { ok: false, conflict: true, diff: diffEnv(localText, remoteText ?? '') };
      }
      // 409: a concurrent write raced us. Per the S3 docs this is transient and
      // the upload may simply be retried — it is NOT a content divergence, so we
      // report a retryable error instead of a (misleading) keep-local/keep-remote prompt.
      if (this.s3.isConditionalConflict(err)) {
        return { ok: false, conflict: false, error: 'Concurrent write detected — please retry.' };
      }
      return {
        ok: false,
        conflict: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private async currentEtag(
    bucket: string,
    region: string,
    objectKey: string,
    auth: EnvSyncAuthResolved
  ): Promise<string | undefined> {
    const h = await this.s3.head(bucket, region, objectKey, auth);
    return h?.etag;
  }

  private async safeRemoteText(
    bucket: string,
    region: string,
    objectKey: string,
    id: string
  ): Promise<string | null> {
    try {
      const passphrase = this.secrets.resolvePassphrase(id);
      const auth = this.secrets.resolveAuth(id);
      const r = await this.s3.get(bucket, region, objectKey, auth);
      return (await this.crypto.decrypt(r.body, passphrase)).toString('utf8');
    } catch {
      return null;
    }
  }

  async resolveConflict(
    repoDir: string,
    envFile: string,
    choice: 'keep-local' | 'keep-remote'
  ): Promise<SyncOutcome> {
    return choice === 'keep-local'
      ? this.push(repoDir, repoDir, envFile, { force: true })
      : this.pull(repoDir, repoDir, envFile, { force: true });
  }

  async diff(repoDir: string, envFile: string): Promise<SyncOutcome> {
    const config = readConfig(repoDir);
    const target = config?.targets.find((t) => t.envFile === envFile);
    if (!config || !target) return { ok: false, conflict: false, error: 'Target not found' };
    const objectKey = resolveObjectKey(config, target);
    const { bucket, region } = resolveBucketRegion(config, target);
    const localText = this.readLocal(repoDir, target) ?? '';
    const remoteText = await this.safeRemoteText(bucket, region, objectKey, config.id);
    return { ok: false, conflict: true, diff: diffEnv(localText, remoteText ?? '') };
  }

  /** For inject delivery at PTY spawn. Returns {} when nothing applies or passphrase locked. */
  async getEnvForCwd(cwd: string): Promise<Record<string, string>> {
    const found = findNearestConfig(cwd);
    if (!found) return {};
    const target = mostSpecificInjectTarget(found.repoDir, found.config, cwd);
    if (!target) return {};
    const objectKey = resolveObjectKey(found.config, target);
    const { bucket, region } = resolveBucketRegion(found.config, target);
    try {
      const auth = this.secrets.resolveAuth(found.config.id);
      const remote = await this.s3.head(bucket, region, objectKey, auth);
      if (!remote) return {};
      const cached = this.injectCache.get(`${objectKey}@${remote.etag}`);
      if (cached) return cached;
      const passphrase = this.secrets.resolvePassphrase(found.config.id);
      const obj = await this.s3.get(bucket, region, objectKey, auth);
      const map = parseEnv((await this.crypto.decrypt(obj.body, passphrase)).toString('utf8')).map;
      // Key by the fetched body's own etag, not the head etag: if the object was
      // replaced between head and get, the body belongs to obj.etag.
      this.injectCache.set(`${objectKey}@${obj.etag}`, map);
      return map;
    } catch {
      return {};
    }
  }
}
