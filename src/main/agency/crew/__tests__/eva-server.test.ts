import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentCatalogModel } from '../../../../shared/agent-types';
import { evaModels, evaServer, evaSettings, readEvaServer, type EvaShell } from '../eva-server';

const KEY = 'sk-or-v1-not-a-real-key';

const CONFIG = `# eva settings
provider = "openrouter"
api_key = "${KEY}"
model = "deepseek/deepseek-chat"

[tools]
model = "not-the-chat-model"
`;

describe('evaSettings', () => {
  it('reads provider, base_url and model, and never the key', () => {
    const settings = evaSettings(CONFIG);
    expect(settings).toEqual({ provider: 'openrouter', model: 'deepseek/deepseek-chat' });
    expect(JSON.stringify(settings)).not.toContain(KEY);
  });

  it('stops at the first table', () => {
    expect(evaSettings('[chat]\nmodel = "x"\n')).toEqual({});
  });

  it('gives nothing for a file that does not parse', () => {
    expect(evaSettings('model = "unclosed\n')).toEqual({});
  });
});

describe('evaServer', () => {
  it('uses the provider defaults when the settings name none', () => {
    expect(evaServer({}, {})).toEqual({
      provider: 'llama.cpp',
      baseUrl: 'http://localhost:11436/v1',
      model: 'qwen3.6-abliterated',
      local: true
    });
    expect(evaServer({ provider: 'openrouter' }, {})).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      local: false
    });
  });

  it('lets the variables win over the file, and trims the trailing slash', () => {
    const server = evaServer(
      { provider: 'openrouter', model: 'a' },
      { provider: 'openai-compatible', base_url: 'http://127.0.0.1:8080/v1/', model: 'b' }
    );
    expect(server).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:8080/v1',
      model: 'b',
      local: true
    });
  });

  it('is not local for a remote openai-compatible server', () => {
    expect(
      evaServer({ provider: 'openai-compatible', base_url: 'https://api.example.com/v1' }, {}).local
    ).toBe(false);
  });
});

describe('readEvaServer', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleet-eva-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /**
   * The real line in `sh`, with `env` as the pane's environment, keeping what
   * Fleet is handed. Trimmed, as `runCapture` hands it over.
   */
  const shell = (env: Record<string, string> = {}): EvaShell & { seen: string[] } => {
    const seen: string[] = [];
    const run: EvaShell = async (line, cwd) =>
      new Promise((done) => {
        execFile(
          '/bin/sh',
          ['-c', line],
          { cwd, env: { PATH: process.env.PATH ?? '', HOME: home, ...env } },
          (err, stdout) => {
            seen.push(stdout);
            done({ code: err ? 1 : 0, stdout: stdout.trim() });
          }
        );
      });
    return Object.assign(run, { seen });
  };

  it('reads the server from the file, and hands Fleet no part of the key', async () => {
    mkdirSync(join(home, '.eva'));
    writeFileSync(join(home, '.eva', 'config.toml'), CONFIG);
    const sh = shell();
    const read = await readEvaServer(home, sh);
    expect(read).toEqual({
      server: {
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-chat',
        local: false
      },
      keySet: true
    });
    expect(sh.seen.join('')).not.toContain(KEY);
    expect(sh.seen.join('')).not.toContain('not-the-chat-model');
  });

  it('reads the config from EVA_HOME and lets the variables win', async () => {
    writeFileSync(join(home, 'config.toml'), 'provider = "openrouter"\n');
    const sh = shell({ EVA_HOME: home, CHAT_MODEL: 'local-model', CHAT_API_KEY: KEY });
    const read = await readEvaServer(home, sh);
    expect(read.server).toMatchObject({ provider: 'openrouter', model: 'local-model' });
    expect(read.keySet).toBe(true);
    expect(sh.seen.join('')).not.toContain(KEY);
  });

  it('says no key for a file and an environment with none', async () => {
    const read = await readEvaServer(home, shell({ CHAT_API_KEY: '' }));
    expect(read).toEqual({ server: evaServer({}, {}), keySet: false });
    writeFileSync(join(home, 'config.toml'), 'api_key = ""\n');
    expect((await readEvaServer(home, shell({ EVA_HOME: home }))).keySet).toBe(false);
  });

  it('knows nothing of the key when the shell cannot start', async () => {
    const read = await readEvaServer(home, vi.fn<EvaShell>().mockResolvedValue(null));
    expect(read.keySet).toBeNull();
  });
});

describe('evaModels', () => {
  const model = (id: string, supportsTools: boolean): AgentCatalogModel =>
    ({ id, supportsTools, contextLimit: 1000, cost: { input: 1, output: 2 } }) as AgentCatalogModel;

  it('lists the OpenRouter models that call tools', async () => {
    const models = await evaModels(evaServer({ provider: 'openrouter' }, {}), {
      openRouter: vi.fn().mockResolvedValue([model('a', true), model('b', false)]),
      fetch: vi.fn()
    });
    expect(models).toEqual([{ id: 'a', contextLimit: 1000, cost: { input: 1, output: 2 } }]);
  });

  it('asks a local server for its models with no key', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ data: [{ id: 'qwen', meta: { n_ctx_train: 32768 } }] }));
    const models = await evaModels(evaServer({}, {}), {
      openRouter: vi.fn().mockResolvedValue([]),
      fetch: fetch as unknown as typeof globalThis.fetch
    });
    expect(models).toEqual([{ id: 'qwen', contextLimit: 32768, cost: null }]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11436/v1/models');
    expect(init.headers).toBeUndefined();
  });

  it('gives null when the list cannot be read', async () => {
    const down = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(
      await evaModels(evaServer({}, {}), {
        openRouter: vi.fn().mockResolvedValue([]),
        fetch: down as unknown as typeof globalThis.fetch
      })
    ).toBeNull();
  });
});
