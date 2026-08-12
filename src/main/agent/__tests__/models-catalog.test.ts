import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentModelCatalog } from '../models-catalog';

const API_RESPONSE = {
  anthropic: { models: {} },
  openrouter: {
    models: {
      'anthropic/claude-sonnet-4.5': {
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        tool_call: true,
        temperature: true,
        reasoning: true,
        reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: 1024, max: 63999 }],
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 1000000, output: 64000 },
        cost: { input: 3, output: 15 },
        release_date: '2025-09-29'
      },
      'google/gemini-3-pro-image': {
        id: 'google/gemini-3-pro-image',
        name: 'Gemini 3 Pro Image',
        modalities: { input: ['text', 'image'], output: ['text', 'image'] }
      },
      // Real entries sometimes name a budget option without any bounds.
      'nvidia/nemotron-3-ultra': {
        id: 'nvidia/nemotron-3-ultra',
        reasoning: true,
        reasoning_options: [
          { type: 'effort', values: ['medium', 'high'] },
          { type: 'budget_tokens' }
        ],
        limit: { context: 1000000, output: 65536 }
      }
    }
  }
};

// OpenRouter's own list, the source of the per-model defaults. models.dev
// publishes none of these.
const OPENROUTER_RESPONSE = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      default_parameters: { temperature: 1, top_p: 1, top_k: null },
      reasoning: { default_enabled: true, mandatory: false }
    },
    {
      id: 'nvidia/nemotron-3-ultra',
      default_parameters: { temperature: null },
      reasoning: { default_enabled: false, default_effort: 'high' }
    },
    {
      id: 'google/gemini-3-pro-image',
      default_parameters: { temperature: null, top_p: null }
    }
  ]
};

/**
 * The images endpoint's own register. Overlaps the catalog above by one entry
 * on purpose: the two lists are separate registers rather than two views of
 * one, and most of what is here never appears in a completions catalog.
 */
const IMAGES_RESPONSE = {
  data: [
    {
      id: 'black-forest-labs/flux.2-pro',
      name: 'Black Forest Labs: FLUX.2 Pro',
      description: 'A text-to-image model.',
      supports_streaming: false,
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '16:9', '4:5'] },
        n: { type: 'range', min: 1, max: 6 },
        input_references: { type: 'range', min: 0, max: 10 },
        seed: { type: 'boolean' },
        output_format: { type: 'enum', values: ['png', 'jpeg'] }
      }
    },
    {
      id: 'openai/gpt-image-2',
      name: 'OpenAI: GPT Image 2',
      supports_streaming: true,
      supported_parameters: {
        aspect_ratio: { type: 'enum', values: ['1:1', '3:2'] },
        quality: { type: 'enum', values: ['low', 'medium', 'high'] },
        input_references: { type: 'range', min: 0, max: 16 }
      }
    },
    {
      id: 'google/gemini-3-pro-image',
      name: 'Google: Nano Banana Pro',
      supported_parameters: {
        resolution: { type: 'enum', values: ['1K', '2K', '4K'] },
        aspect_ratio: { type: 'enum', values: ['1:1'] }
      }
    }
  ]
};

/**
 * Routes by URL, since a download reads models.dev, OpenRouter's model list and
 * its images register together.
 */
function fakeFetch(
  body: unknown,
  {
    ok = true,
    openrouter = OPENROUTER_RESPONSE as unknown,
    images = IMAGES_RESPONSE as unknown
  }: { ok?: boolean; openrouter?: unknown; images?: unknown } = {}
): typeof fetch {
  return vi.fn(async (url: string) =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: async () =>
        Promise.resolve(
          url.includes('/images/models')
            ? images
            : url.includes('openrouter.ai')
              ? openrouter
              : body
        )
    })
  ) as unknown as typeof fetch;
}

async function cacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-catalog-'));
  return join(dir, 'nested', 'models.json');
}

describe('AgentModelCatalog', () => {
  it('maps the openrouter slice of models.dev into catalog models', async () => {
    const catalog = new AgentModelCatalog(await cacheFile(), fakeFetch(API_RESPONSE));
    const { models, source, error } = await catalog.list();

    expect(source).toBe('network');
    expect(error).toBeNull();
    expect(models.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-pro-image',
      'nvidia/nemotron-3-ultra'
    ]);

    const sonnet = models[0];
    expect(sonnet.contextLimit).toBe(1000000);
    expect(sonnet.outputLimit).toBe(64000);
    expect(sonnet.supportsTools).toBe(true);
    expect(sonnet.inputImage).toBe(true);
    expect(sonnet.outputImage).toBe(false);
    expect(sonnet.reasoning).toEqual([
      { type: 'toggle' },
      { type: 'budget_tokens', min: 1024, max: 63999 }
    ]);
    expect(sonnet.cost).toEqual({ input: 3, output: 15 });

    // Absent capability flags mean "no", not "unknown".
    const gemini = models[1];
    expect(gemini.supportsTools).toBe(false);
    expect(gemini.outputImage).toBe(true);
    expect(gemini.reasoning).toEqual([]);
  });

  it('fills in thinking-budget bounds the feed leaves out', async () => {
    const catalog = new AgentModelCatalog(await cacheFile(), fakeFetch(API_RESPONSE));
    const { models } = await catalog.list();
    const nemotron = models.find((m) => m.id === 'nvidia/nemotron-3-ultra');

    expect(nemotron?.reasoning).toEqual([
      { type: 'effort', values: ['medium', 'high'] },
      // Bounded by the model's own output ceiling when models.dev omits it.
      { type: 'budget_tokens', min: 1024, max: 65536 }
    ]);
  });

  it('annotates models with the defaults OpenRouter publishes', async () => {
    const catalog = new AgentModelCatalog(await cacheFile(), fakeFetch(API_RESPONSE));
    const { models } = await catalog.list();

    const sonnet = models.find((m) => m.id === 'anthropic/claude-sonnet-4.5');
    expect(sonnet?.defaultTemperature).toBe(1);
    expect(sonnet?.defaultReasoningEnabled).toBe(true);

    const nemotron = models.find((m) => m.id === 'nvidia/nemotron-3-ultra');
    expect(nemotron?.defaultTemperature).toBeNull();
    expect(nemotron?.defaultReasoningEnabled).toBe(false);
    expect(nemotron?.defaultReasoningEffort).toBe('high');

    // Most models publish nothing, which has to stay distinguishable from a
    // value we made up.
    const gemini = models.find((m) => m.id === 'google/gemini-3-pro-image');
    expect(gemini?.defaultTemperature).toBeNull();
    expect(gemini?.defaultReasoningEnabled).toBeNull();
    expect(gemini?.defaultReasoningEffort).toBeNull();
  });

  it('drops a default effort the capability catalog does not offer', async () => {
    const mismatched = {
      data: [
        {
          id: 'nvidia/nemotron-3-ultra',
          reasoning: { default_effort: 'xhigh' }
        }
      ]
    };
    const { models } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(API_RESPONSE, { openrouter: mismatched })
    ).list();

    // models.dev lists only medium and high for this model.
    expect(
      models.find((m) => m.id === 'nvidia/nemotron-3-ultra')?.defaultReasoningEffort
    ).toBeNull();
  });

  it('still returns the catalog when the defaults list is unavailable', async () => {
    const { models, error } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(API_RESPONSE, { openrouter: { unexpected: true } })
    ).list();

    expect(error).toBeNull();
    expect(models).toHaveLength(3);
    expect(models.every((m) => m.defaultTemperature === null)).toBe(true);
  });

  it('skips malformed entries instead of failing the whole catalog', async () => {
    const withJunk = {
      openrouter: {
        models: {
          ...API_RESPONSE.openrouter.models,
          'broken/model': { name: 'No id at all' },
          'also/broken': 'not even an object'
        }
      }
    };
    const { models, error } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(withJunk)
    ).list();

    expect(error).toBeNull();
    expect(models).toHaveLength(3);
  });

  it('treats a catalog with nothing usable as a failure', async () => {
    const empty = { openrouter: { models: { 'broken/model': { name: 'No id' } } } };
    const { models, source, error } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(empty)
    ).list();

    expect(source).toBe('none');
    expect(models).toEqual([]);
    expect(error).toMatch(/no usable/i);
  });

  it('writes a cache and serves it without hitting the network again', async () => {
    const file = await cacheFile();
    const fetchImpl = fakeFetch(API_RESPONSE);
    await new AgentModelCatalog(file, fetchImpl).list();
    // One request each to models.dev, OpenRouter's models and its images.
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // A fresh instance reads the file rather than downloading.
    const second = new AgentModelCatalog(file, fetchImpl);
    const result = await second.list();
    expect(result.source).toBe('cache');
    expect(result.models).toHaveLength(3);
    expect(result.imageModels).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('falls back to the cached list when the refresh fails', async () => {
    const file = await cacheFile();
    await new AgentModelCatalog(file, fakeFetch(API_RESPONSE)).list();

    const failing = vi.fn(async () =>
      Promise.reject(new Error('offline'))
    ) as unknown as typeof fetch;
    const result = await new AgentModelCatalog(file, failing).list(true);

    expect(result.source).toBe('cache');
    expect(result.error).toBe('offline');
    expect(result.models).toHaveLength(3);
  });

  it('reports an empty catalog when there is no cache to fall back on', async () => {
    const failing = vi.fn(async () =>
      Promise.reject(new Error('offline'))
    ) as unknown as typeof fetch;
    const result = await new AgentModelCatalog(await cacheFile(), failing).list();

    expect(result).toEqual({
      models: [],
      imageModels: [],
      fetchedAt: 0,
      source: 'none',
      error: 'offline'
    });
  });

  it('reads image models from the images register, not from the catalog', async () => {
    const { models, imageModels } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(API_RESPONSE)
    ).list();

    // The completions catalog knows about exactly one of these, which is the
    // whole reason the second list exists.
    expect(models.filter((m) => m.outputImage).map((m) => m.id)).toEqual([
      'google/gemini-3-pro-image'
    ]);
    expect(imageModels.map((m) => m.id)).toEqual([
      'black-forest-labs/flux.2-pro',
      'google/gemini-3-pro-image',
      'openai/gpt-image-2'
    ]);
  });

  it('reads each image model’s parameters as the lists a control is drawn from', async () => {
    const { imageModels } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(API_RESPONSE)
    ).list();

    const flux = imageModels.find((m) => m.id === 'black-forest-labs/flux.2-pro');
    expect(flux?.aspectRatios).toEqual(['1:1', '16:9', '4:5']);
    expect(flux?.maxReferences).toBe(10);
    expect(flux?.seed).toBe(true);
    // Absent parameters are empty lists rather than defaults of ours: this
    // model has no resolution and no quality, so neither control is drawn.
    expect(flux?.resolutions).toEqual([]);
    expect(flux?.qualities).toEqual([]);
    expect(flux?.streams).toBe(false);

    const gpt = imageModels.find((m) => m.id === 'openai/gpt-image-2');
    expect(gpt?.qualities).toEqual(['low', 'medium', 'high']);
    expect(gpt?.seed).toBe(false);
    expect(gpt?.streams).toBe(true);

    // `supports_streaming` is absent here, which means no rather than unknown.
    const gemini = imageModels.find((m) => m.id === 'google/gemini-3-pro-image');
    expect(gemini?.resolutions).toEqual(['1K', '2K', '4K']);
    expect(gemini?.maxReferences).toBe(0);
    expect(gemini?.streams).toBe(false);
  });

  it('fails the refresh when the images register cannot be read', async () => {
    // Unlike the defaults list, this one is not best effort: an empty image
    // list is indistinguishable from "image generation is unavailable".
    const { source, error } = await new AgentModelCatalog(
      await cacheFile(),
      fakeFetch(API_RESPONSE, { images: { data: [{ no: 'id' }] } })
    ).list();

    expect(source).toBe('none');
    expect(error).toMatch(/no usable image models/i);
  });

  it('answers what a model takes without touching the network', async () => {
    const catalog = new AgentModelCatalog(await cacheFile(), fakeFetch(API_RESPONSE));

    // Nothing downloaded yet, so the turn gets no answer rather than a wait.
    expect(catalog.cachedImageModel('black-forest-labs/flux.2-pro')).toBeNull();

    await catalog.list();
    expect(catalog.cachedImageModel('black-forest-labs/flux.2-pro')?.maxReferences).toBe(10);
    expect(catalog.cachedImageModel('openrouter/auto')).toBeNull();
  });

  it('re-downloads a cache written before image models were fetched', async () => {
    const file = await cacheFile();
    await new AgentModelCatalog(file, fakeFetch(API_RESPONSE)).list();

    // What an older Fleet wrote. Its image models were the wrong ones, so the
    // whole file is discarded rather than half-trusted.
    const stale = JSON.parse(await readFile(file, 'utf8'));
    delete stale.imageModels;
    await writeFile(file, JSON.stringify(stale), 'utf8');

    const result = await new AgentModelCatalog(file, fakeFetch(API_RESPONSE)).list();
    expect(result.source).toBe('network');
    expect(result.imageModels).toHaveLength(3);
  });

  it('ignores a corrupt cache file', async () => {
    const file = await cacheFile();
    await new AgentModelCatalog(file, fakeFetch(API_RESPONSE)).list();
    await writeFile(file, '{ not json', 'utf8');

    const result = await new AgentModelCatalog(file, fakeFetch(API_RESPONSE)).list();
    expect(result.source).toBe('network');
    expect(JSON.parse(await readFile(file, 'utf8'))).toHaveProperty('models');
  });
});
