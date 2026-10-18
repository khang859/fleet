import { describe, expect, it, vi } from 'vitest';
import type { AgentCatalogModel } from '../../../../shared/agent-types';
import {
  evaModels,
  evaServer,
  evaSettings,
  readEvaServer,
  type EvaServerDeps
} from '../eva-server';

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
  const deps = (stdout: string, config: string): EvaServerDeps => ({
    shell: vi.fn<EvaServerDeps['shell']>().mockResolvedValue({ code: 0, stdout }),
    readText: vi.fn<EvaServerDeps['readText']>().mockResolvedValue(config),
    home: '/home/me'
  });

  it('asks the shell for the variables by name, never for the key', async () => {
    const d = deps('\n\n\n\n', CONFIG);
    const server = await readEvaServer('/repo', d);
    expect(server.model).toBe('deepseek/deepseek-chat');
    expect(d.readText).toHaveBeenCalledWith('/home/me/.eva/config.toml');
    const line = vi.mocked(d.shell).mock.calls[0][0];
    expect(line).toContain('$CHAT_MODEL');
    expect(line).not.toContain('CHAT_API_KEY');
    expect(JSON.stringify(server)).not.toContain(KEY);
  });

  it('reads the config from EVA_HOME and takes the variables first', async () => {
    const d = deps('/opt/eva\n\n\nlocal-model\n', CONFIG);
    const server = await readEvaServer('/repo', d);
    expect(d.readText).toHaveBeenCalledWith('/opt/eva/config.toml');
    expect(server).toMatchObject({ provider: 'openrouter', model: 'local-model' });
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
