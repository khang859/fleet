import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RuneConfigManager, RuneConfigParseError } from '../rune-config-manager';

function makeTestDir(): string {
  const dir = join(
    tmpdir(),
    `fleet-rune-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('RuneConfigManager — readSettings', () => {
  let dir: string;
  let mgr: RuneConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new RuneConfigManager({ configDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns empty object when file missing', async () => {
    expect(await mgr.readSettings()).toEqual({});
  });

  it('parses existing settings.json', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ provider: 'codex', reasoning_effort: 'high' })
    );
    const s = await mgr.readSettings();
    expect(s.provider).toBe('codex');
    expect(s.reasoning_effort).toBe('high');
  });

  it('preserves unknown fields', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ provider: 'codex', future_flag: { nested: 1 } })
    );
    const s = await mgr.readSettings();
    expect(s).toMatchObject({ future_flag: { nested: 1 } });
  });

  it('throws RuneConfigParseError on malformed JSON', async () => {
    writeFileSync(join(dir, 'settings.json'), '{ not valid json');
    await expect(mgr.readSettings()).rejects.toBeInstanceOf(RuneConfigParseError);
  });
});

describe('RuneConfigManager — writeSettings (deep merge onto raw)', () => {
  let dir: string;
  let mgr: RuneConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new RuneConfigManager({ configDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the file when none exists', async () => {
    await mgr.writeSettings({ provider: 'groq' });
    const written = readJson(join(dir, 'settings.json'));
    expect(written.provider).toBe('groq');
  });

  it('deep-merges nested objects instead of replacing them', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        web: { fetch_enabled: true, search_enabled: 'auto', search_provider: 'tavily' }
      })
    );
    await mgr.writeSettings({ web: { fetch_enabled: false } });
    const written = readJson(join(dir, 'settings.json')) as { web: Record<string, unknown> };
    expect(written.web).toEqual({
      fetch_enabled: false,
      search_enabled: 'auto',
      search_provider: 'tavily'
    });
  });

  it('preserves unknown top-level and nested keys the renderer never sent', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        provider: 'codex',
        model_capabilities: { 'gpt-x': { tools: 'on' } },
        subagents: { enabled: true, max_concurrent: 4, secret_knob: 9 }
      })
    );
    await mgr.writeSettings({ subagents: { max_concurrent: 8 } });
    const written = readJson(join(dir, 'settings.json')) as {
      provider: string;
      model_capabilities: unknown;
      subagents: Record<string, unknown>;
    };
    expect(written.provider).toBe('codex');
    expect(written.model_capabilities).toEqual({ 'gpt-x': { tools: 'on' } });
    expect(written.subagents).toEqual({ enabled: true, max_concurrent: 8, secret_knob: 9 });
  });

  it('writes an empty string (clear-to-default), not a no-op', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ codex_model: 'gpt-5.5' }));
    await mgr.writeSettings({ codex_model: '' });
    const written = readJson(join(dir, 'settings.json'));
    expect(written.codex_model).toBe('');
  });

  it('skips undefined values, leaving the base untouched', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ codex_model: 'gpt-5.5' }));
    await mgr.writeSettings({ codex_model: undefined, provider: 'codex' });
    const written = readJson(join(dir, 'settings.json'));
    expect(written.codex_model).toBe('gpt-5.5');
    expect(written.provider).toBe('codex');
  });

  it('replaces arrays wholesale (profiles)', async () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ profiles: [{ id: 'a', provider: 'ollama' }] })
    );
    await mgr.writeSettings({ profiles: [{ id: 'b', provider: 'groq' }] });
    const written = readJson(join(dir, 'settings.json')) as { profiles: unknown[] };
    expect(written.profiles).toEqual([{ id: 'b', provider: 'groq' }]);
  });

  it('writes to a real file, not the .tmp scratch file', async () => {
    await mgr.writeSettings({ provider: 'codex' });
    expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, 'settings.json.tmp'))).toBe(false);
  });

  it('serializes concurrent writes without clobbering', async () => {
    await Promise.all([
      mgr.writeSettings({ provider: 'codex' }),
      mgr.writeSettings({ reasoning_effort: 'high' }),
      mgr.writeSettings({ icon_mode: 'nerd' })
    ]);
    const written = readJson(join(dir, 'settings.json'));
    expect(written.provider).toBe('codex');
    expect(written.reasoning_effort).toBe('high');
    expect(written.icon_mode).toBe('nerd');
  });
});

describe('RuneConfigManager — secrets', () => {
  let dir: string;
  let mgr: RuneConfigManager;

  beforeEach(() => {
    dir = makeTestDir();
    mgr = new RuneConfigManager({ configDir: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns empty object when secrets.json missing', async () => {
    expect(await mgr.readSecrets()).toEqual({});
  });

  it('merges secret patches and drops empty values to unset a key', async () => {
    await mgr.writeSecrets({ groq_api_key: 'gsk_1', tavily_api_key: 'tvly_1' });
    await mgr.writeSecrets({ groq_api_key: '', brave_search_api_key: 'bsa_1' });
    const secrets = await mgr.readSecrets();
    expect(secrets).toEqual({ tavily_api_key: 'tvly_1', brave_search_api_key: 'bsa_1' });
  });
});

describe('RuneConfigManager — RUNE_DIR resolution', () => {
  it('honors $RUNE_DIR when no explicit configDir is given', async () => {
    const dir = makeTestDir();
    const prev = process.env.RUNE_DIR;
    process.env.RUNE_DIR = dir;
    try {
      const mgr = new RuneConfigManager();
      await mgr.writeSettings({ provider: 'codex' });
      expect(existsSync(join(dir, 'settings.json'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.RUNE_DIR;
      else process.env.RUNE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
