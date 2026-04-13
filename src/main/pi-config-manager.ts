import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { shell } from 'electron';
import { createLogger } from './logger';
import {
  PiSettingsSchema,
  PiModelsFileSchema,
  type PiSettings,
  type PiProvider,
  type PiModelsFile
} from '../shared/pi-config-types';

const log = createLogger('pi-config-manager');

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
      if (Array.isArray(p)) {
        path = (p as unknown[]).map((s) => String(s)).join('.');
      }
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

export class PiConfigParseError extends Error {
  constructor(
    public readonly file: string,
    public readonly originalMessage: string,
    public readonly rawSnippet?: string
  ) {
    super(`Failed to parse ${file}: ${originalMessage}`);
    this.name = 'PiConfigParseError';
  }
}

export class PiConfigValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: Array<{ path: string; message: string }>
  ) {
    super(
      `Invalid ${file}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`
    );
    this.name = 'PiConfigValidationError';
  }
}

type PiConfigManagerOptions = {
  configDir?: string;
};

export class PiConfigManager {
  private readonly configDir: string;
  private readonly settingsPath: string;
  private readonly modelsPath: string;
  private readonly authPath: string;
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(opts: PiConfigManagerOptions = {}) {
    this.configDir = opts.configDir ?? join(homedir(), '.pi', 'agent');
    this.settingsPath = join(this.configDir, 'settings.json');
    this.modelsPath = join(this.configDir, 'models.json');
    this.authPath = join(this.configDir, 'auth.json');
  }

  getConfigDir(): string {
    return this.configDir;
  }

  getAuthPath(): string {
    return this.authPath;
  }

  async readSettings(): Promise<PiSettings> {
    return this.readParsed(this.settingsPath, 'settings.json', (raw) =>
      PiSettingsSchema.parse(raw)
    );
  }

  async readModels(): Promise<PiModelsFile> {
    return this.readParsed(this.modelsPath, 'models.json', (raw) =>
      PiModelsFileSchema.parse(raw ?? {})
    );
  }

  async openConfigFolder(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
    await shell.openPath(this.configDir);
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
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        return parse(fileLabel === 'models.json' ? { providers: {} } : {});
      }
      throw err;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err: unknown) {
      throw new PiConfigParseError(fileLabel, messageOf(err), text.slice(0, 200));
    }

    try {
      return parse(raw);
    } catch (err: unknown) {
      throw new PiConfigValidationError(fileLabel, extractZodIssues(err));
    }
  }

  async writeSettings(patch: Partial<PiSettings>): Promise<void> {
    await this.withLock(this.settingsPath, async () => {
      const current = await this.readSettings();
      const merged = { ...current, ...patch };
      await this.atomicWriteJson(this.settingsPath, merged);
    });
  }

  async writeProvider(id: string, provider: PiProvider): Promise<void> {
    await this.withLock(this.modelsPath, async () => {
      const current = await this.readModels();
      const providers = { ...current.providers, [id]: provider };
      await this.atomicWriteJson(this.modelsPath, { ...current, providers });
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.withLock(this.modelsPath, async () => {
      const current = await this.readModels();
      if (!(id in current.providers)) return;
      const providers = { ...current.providers };
      delete providers[id];
      await this.atomicWriteJson(this.modelsPath, { ...current, providers });
    });
  }

  async renameProvider(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    await this.withLock(this.modelsPath, async () => {
      const current = await this.readModels();
      const value = current.providers[oldId];
      if (!value) return;
      const providers = { ...current.providers, [newId]: value };
      delete providers[oldId];
      await this.atomicWriteJson(this.modelsPath, { ...current, providers });
    });
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
    log.debug('wrote pi config', { path });
  }
}
