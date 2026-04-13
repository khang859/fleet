import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiConfigManager } from '../pi-config-manager';

function makeTestDir(): string {
  const dir = join(
    tmpdir(),
    `fleet-pi-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
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

describe('PiConfigManager — writeSettings', () => {
  let dir: string;
  let mgr: PiConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new PiConfigManager({ configDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file on first write', async () => {
    await mgr.writeSettings({ defaultProvider: 'anthropic' });
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(raw.defaultProvider).toBe('anthropic');
  });

  it('preserves unknown fields across patch', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'openai',
        compaction: { enabled: true, reserveTokens: 16384 },
        unknownField: 'keep me'
      })
    );
    await mgr.writeSettings({ defaultProvider: 'anthropic' });
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(raw.defaultProvider).toBe('anthropic');
    expect(raw.compaction).toEqual({ enabled: true, reserveTokens: 16384 });
    expect(raw.unknownField).toBe('keep me');
  });

  it('serializes concurrent writes (no interleave)', async () => {
    await Promise.all([
      mgr.writeSettings({ defaultProvider: 'a' }),
      mgr.writeSettings({ defaultModel: 'm1' }),
      mgr.writeSettings({ theme: 'dark' })
    ]);
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(raw.defaultProvider).toBe('a');
    expect(raw.defaultModel).toBe('m1');
    expect(raw.theme).toBe('dark');
  });
});

describe('PiConfigManager — writeProvider / deleteProvider / renameProvider', () => {
  let dir: string;
  let mgr: PiConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new PiConfigManager({ configDir: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('upserts a provider into empty models.json', async () => {
    await mgr.writeProvider('ollama', {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      models: [{ id: 'llama3.1:8b' }]
    });
    const raw = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf-8')) as {
      providers: Record<string, { baseUrl?: string; models?: Array<{ id: string }> }>;
    };
    expect(raw.providers.ollama.baseUrl).toBe('http://localhost:11434/v1');
    expect(raw.providers.ollama.models?.[0].id).toBe('llama3.1:8b');
  });

  it('does not touch sibling providers', async () => {
    await mgr.writeProvider('ollama', { baseUrl: 'http://a' });
    await mgr.writeProvider('lm-studio', { baseUrl: 'http://b' });
    const raw = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf-8')) as {
      providers: Record<string, { baseUrl?: string }>;
    };
    expect(raw.providers.ollama.baseUrl).toBe('http://a');
    expect(raw.providers['lm-studio'].baseUrl).toBe('http://b');
  });

  it('deleteProvider removes only the target', async () => {
    await mgr.writeProvider('a', { baseUrl: 'http://a' });
    await mgr.writeProvider('b', { baseUrl: 'http://b' });
    await mgr.deleteProvider('a');
    const raw = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf-8')) as {
      providers: Record<string, unknown>;
    };
    expect(raw.providers).not.toHaveProperty('a');
    expect(raw.providers.b).toBeDefined();
  });

  it('renameProvider keeps value and deletes old key', async () => {
    await mgr.writeProvider('old', { baseUrl: 'http://x' });
    await mgr.renameProvider('old', 'new');
    const raw = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf-8')) as {
      providers: Record<string, { baseUrl?: string }>;
    };
    expect(raw.providers.old).toBeUndefined();
    expect(raw.providers.new.baseUrl).toBe('http://x');
  });

  it('preserves unknown top-level fields in models.json', async () => {
    writeFileSync(
      join(dir, 'models.json'),
      JSON.stringify({ providers: {}, somePiInternal: { x: 1 } })
    );
    await mgr.writeProvider('z', { baseUrl: 'http://z' });
    const raw = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(raw.somePiInternal).toEqual({ x: 1 });
  });
});
