import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { shell } from 'electron';
import { createLogger } from './logger';
import {
  RuneSettingsSchema,
  RuneSecretsSchema,
  type RuneSettings,
  type RuneSecrets
} from '../shared/rune-config-types';

const log = createLogger('rune-config-manager');

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  return 'Unknown error';
}

function extractZodIssues(err: unknown): Array<{ path: string; message: string }> {
  if (err === null || typeof err !== 'object' || !('issues' in err)) {
    return [{ path: '', message: messageOf(err) }];
  }
  const issues: unknown = err.issues;
  if (!Array.isArray(issues)) {
    return [{ path: '', message: messageOf(err) }];
  }
  const results: Array<{ path: string; message: string }> = [];
  for (const raw of issues as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue;
    let path = '';
    if ('path' in raw) {
      const p: unknown = raw.path;
      if (Array.isArray(p)) path = (p as unknown[]).map((s) => String(s)).join('.');
    }
    let message = '';
    if ('message' in raw) {
      const m: unknown = raw.message;
      if (typeof m === 'string') message = m;
    }
    results.push({ path, message });
  }
  return results;
}

export class RuneConfigParseError extends Error {
  constructor(
    public readonly file: string,
    public readonly originalMessage: string,
    public readonly rawSnippet?: string
  ) {
    super(`Failed to parse ${file}: ${originalMessage}`);
    this.name = 'RuneConfigParseError';
  }
}

export class RuneConfigValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: Array<{ path: string; message: string }>
  ) {
    super(`Invalid ${file}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'RuneConfigValidationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merge `patch` onto `base`. Plain objects merge recursively; arrays and
 * scalars from `patch` replace those in `base`. A patch value of `undefined`
 * leaves the base value untouched. Both inputs are left unmutated.
 */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = deepMerge(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

type RuneConfigManagerOptions = {
  configDir?: string;
};

/** Resolve the rune config dir, mirroring rune's internal/config/paths.go. */
function resolveRuneDir(): string {
  const fromEnv = process.env.RUNE_DIR;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  return join(homedir(), '.rune');
}

export class RuneConfigManager {
  private readonly configDir: string;
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(opts: RuneConfigManagerOptions = {}) {
    this.configDir = opts.configDir ?? resolveRuneDir();
    this.settingsPath = join(this.configDir, 'settings.json');
    this.secretsPath = join(this.configDir, 'secrets.json');
  }

  getConfigDir(): string {
    return this.configDir;
  }

  async readSettings(): Promise<RuneSettings> {
    return this.readParsed(this.settingsPath, 'settings.json', (raw) =>
      RuneSettingsSchema.parse(raw ?? {})
    );
  }

  async readSecrets(): Promise<RuneSecrets> {
    return this.readParsed(this.secretsPath, 'secrets.json', (raw) =>
      RuneSecretsSchema.parse(raw ?? {})
    );
  }

  async openConfigFolder(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
    await shell.openPath(this.configDir);
  }

  /**
   * Merge `patch` into settings.json. Reads the *raw* on-disk JSON (not the
   * schema-parsed object) as the merge base so any keys rune knows but Fleet
   * doesn't model — and any nested fields the renderer didn't send — survive.
   */
  async writeSettings(patch: Partial<RuneSettings>): Promise<void> {
    RuneSettingsSchema.partial().parse(patch);
    await this.withLock(this.settingsPath, async () => {
      const base = await this.readRaw(this.settingsPath, 'settings.json');
      // Safe widening to an index-signature type for the structural merge; the
      // shape was already validated by the schema parse above.
      const merged = deepMerge(base, patch as Record<string, unknown>);
      await this.atomicWriteJson(this.settingsPath, merged);
    });
  }

  /**
   * Merge `patch` into secrets.json. An empty-string value unsets that key,
   * so the UI can clear a saved API key.
   */
  async writeSecrets(patch: Record<string, string>): Promise<void> {
    await this.withLock(this.secretsPath, async () => {
      const base = await this.readRaw(this.secretsPath, 'secrets.json');
      const merged: Record<string, unknown> = { ...base };
      for (const [key, value] of Object.entries(patch)) {
        if (value === '') delete merged[key];
        else merged[key] = value;
      }
      await this.atomicWriteJson(this.secretsPath, merged);
    });
  }

  private async readRaw(path: string, fileLabel: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return {};
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err: unknown) {
      throw new RuneConfigParseError(fileLabel, messageOf(err), text.slice(0, 200));
    }
    return isPlainObject(raw) ? raw : {};
  }

  private async readParsed<T>(
    path: string,
    fileLabel: string,
    parse: (raw: unknown) => T
  ): Promise<T> {
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return parse({});
      throw err;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err: unknown) {
      throw new RuneConfigParseError(fileLabel, messageOf(err), text.slice(0, 200));
    }
    try {
      return parse(raw);
    } catch (err: unknown) {
      throw new RuneConfigValidationError(fileLabel, extractZodIssues(err));
    }
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(path) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => (resolveNext = r));
    const chain = prev.then(async () => next);
    this.writeLocks.set(path, chain);
    try {
      await prev;
      return await fn();
    } finally {
      resolveNext();
      if (this.writeLocks.get(path) === chain) {
        this.writeLocks.delete(path);
      }
    }
  }

  private async atomicWriteJson(path: string, obj: unknown): Promise<void> {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmp = `${path}.tmp`;
    const text = `${JSON.stringify(obj, null, 2)}\n`;
    await writeFile(tmp, text, 'utf-8');
    await rename(tmp, path);
    log.debug('wrote rune config', { path });
  }
}
