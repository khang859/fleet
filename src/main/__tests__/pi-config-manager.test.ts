import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiConfigManager } from '../pi-config-manager';

function makeTestDir(): string {
  const dir = join(tmpdir(), `fleet-pi-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('PiConfigManager — readSettings', () => {
  let dir: string;
  let mgr: PiConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new PiConfigManager({ configDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty object when file missing', async () => {
    const s = await mgr.readSettings();
    expect(s).toEqual({});
  });

  it('parses existing settings.json', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'anthropic', theme: 'dark' })
    );
    const s = await mgr.readSettings();
    expect(s.defaultProvider).toBe('anthropic');
    expect(s.theme).toBe('dark');
  });

  it('preserves unknown fields', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'openai',
        compaction: { enabled: true, reserveTokens: 16384 }
      })
    );
    const s = await mgr.readSettings();
    expect(s).toMatchObject({ compaction: { enabled: true, reserveTokens: 16384 } });
  });

  it('throws PiConfigParseError on malformed JSON', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ not valid json');
    await expect(mgr.readSettings()).rejects.toThrow(/parse/i);
  });
});

describe('PiConfigManager — readModels', () => {
  let dir: string;
  let mgr: PiConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new PiConfigManager({ configDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns { providers: {} } when file missing', async () => {
    const m = await mgr.readModels();
    expect(m).toEqual({ providers: {} });
  });

  it('parses providers and preserves unknown fields', async () => {
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({
        providers: {
          ollama: {
            baseUrl: 'http://localhost:11434/v1',
            api: 'openai-completions',
            apiKey: 'ollama',
            novelField: 'preserved',
            models: [{ id: 'llama3.1:8b', cacheHint: 'keep' }]
          }
        }
      })
    );
    const m = await mgr.readModels();
    expect(m.providers.ollama).toMatchObject({ novelField: 'preserved' });
    expect(m.providers.ollama.models?.[0]).toMatchObject({ cacheHint: 'keep' });
  });
});
