import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { shell } from 'electron';
import {
  PiSettingsSchema,
  PiModelsFileSchema,
  type PiSettings,
  type PiModelsFile
} from '../shared/pi-config-types';

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
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return parse(fileLabel === 'models.json' ? { providers: {} } : {});
      }
      throw err;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PiConfigParseError(fileLabel, msg, text.slice(0, 200));
    }

    try {
      return parse(raw);
    } catch (err: unknown) {
      const issues =
        err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown[] }).issues)
          ? ((err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues.map(
              (i) => ({ path: i.path.join('.'), message: i.message })
            ))
          : [{ path: '', message: err instanceof Error ? err.message : String(err) }];
      throw new PiConfigValidationError(fileLabel, issues);
    }
  }
}
