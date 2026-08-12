import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { z } from 'zod';
import type {
  AgentCatalog,
  AgentCatalogModel,
  AgentImageModel,
  AgentReasoningOption
} from '../../shared/agent-types';

const CATALOG_URL = 'https://models.dev/api.json';
/**
 * models.dev describes what a model *can* do but publishes no defaults, so the
 * numbers a parameter falls back to come from OpenRouter's own model list.
 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
/**
 * The images endpoint keeps its own register of what it will run, and it is not
 * a subset of the one above: most image models never appear in a completions
 * catalog, and at least one entry that does (`openrouter/auto`) is refused here.
 */
const OPENROUTER_IMAGES_URL = 'https://openrouter.ai/api/v1/images/models';
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * models.dev publishes one record per provider. We only read the `openrouter`
 * block, and only the fields the settings UI needs - everything else is
 * stripped so the cached copy stays small.
 */
/**
 * Reasoning metadata is the least uniform part of the feed: some entries name a
 * `budget_tokens` option without saying what the bounds are. Everything past
 * `type` is therefore optional here and normalized in `toCatalogModel`.
 */
const reasoningOptionSchema = z.union([
  z.object({ type: z.literal('toggle') }),
  z.object({ type: z.literal('effort'), values: z.array(z.string()).optional() }),
  z.object({
    type: z.literal('budget_tokens'),
    min: z.number().optional(),
    max: z.number().optional()
  })
]);

const modelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  tool_call: z.boolean().optional(),
  temperature: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(reasoningOptionSchema).optional(),
  modalities: z
    .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
    .optional(),
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
  cost: z.object({ input: z.number().optional(), output: z.number().optional() }).optional(),
  release_date: z.string().optional()
});

// Entries are validated one at a time (see `download`) so a single odd model
// costs us that model rather than the whole catalog.
const catalogResponseSchema = z.object({
  openrouter: z.object({ models: z.record(z.string(), z.unknown()) })
});

/**
 * Only the default-bearing fields of OpenRouter's model list. Every one of them
 * is absent for most models, which is itself the answer: no published default.
 */
const openRouterDefaultsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      default_parameters: z.object({ temperature: z.number().nullish() }).nullish(),
      reasoning: z
        .object({
          default_enabled: z.boolean().nullish(),
          default_effort: z.string().nullish()
        })
        .nullish()
    })
  )
});

/**
 * A parameter the images endpoint publishes per model. Only the enums say
 * anything a control can be drawn from; a range matters for `input_references`
 * alone, and a bare presence is the whole of what `seed` has to say.
 */
const imageParameterSchema = z.union([
  z.object({ type: z.literal('enum'), values: z.array(z.string()) }),
  z.object({ type: z.literal('range'), min: z.number(), max: z.number() }),
  z.object({ type: z.literal('boolean') })
]);

const imageModelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  supports_streaming: z.boolean().optional(),
  supported_parameters: z.record(z.string(), imageParameterSchema).optional()
});

const imagesResponseSchema = z.object({ data: z.array(z.unknown()) });

type ModelDefaults = {
  temperature: number | null;
  reasoningEnabled: boolean | null;
  reasoningEffort: string | null;
};

const NO_DEFAULTS: ModelDefaults = {
  temperature: null,
  reasoningEnabled: null,
  reasoningEffort: null
};

const cacheSchema = z.object({
  fetchedAt: z.number(),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      contextLimit: z.number().nullable(),
      outputLimit: z.number().nullable(),
      supportsTools: z.boolean(),
      supportsTemperature: z.boolean(),
      inputImage: z.boolean(),
      outputImage: z.boolean(),
      reasoning: z.array(
        z.union([
          z.object({ type: z.literal('toggle') }),
          z.object({ type: z.literal('effort'), values: z.array(z.string()) }),
          z.object({ type: z.literal('budget_tokens'), min: z.number(), max: z.number() })
        ])
      ),
      cost: z.object({ input: z.number(), output: z.number() }).nullable(),
      releaseDate: z.string().nullable(),
      defaultTemperature: z.number().nullable(),
      defaultReasoningEnabled: z.boolean().nullable(),
      defaultReasoningEffort: z.string().nullable()
    })
  ),
  // Absent in a cache written before image models were fetched separately.
  // The whole file fails to parse and is re-downloaded, which is what should
  // happen: the old file's image models were the wrong ones.
  imageModels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      resolutions: z.array(z.string()),
      qualities: z.array(z.string()),
      aspectRatios: z.array(z.string()),
      seed: z.boolean(),
      maxReferences: z.number(),
      streams: z.boolean()
    })
  )
});

type Cached = { fetchedAt: number; models: AgentCatalogModel[]; imageModels: AgentImageModel[] };

/** Default floor for a thinking budget the feed leaves unbounded. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Fills in the bounds the feed omits, and drops options it cannot describe -
 * a slider with no range is worse than no slider.
 */
function toReasoningOptions(
  raw: z.infer<typeof modelSchema>,
  outputLimit: number | null
): AgentReasoningOption[] {
  if (!raw.reasoning) return [];
  const options: AgentReasoningOption[] = [];
  for (const option of raw.reasoning_options ?? []) {
    if (option.type === 'toggle') {
      options.push(option);
    } else if (option.type === 'effort') {
      if (option.values && option.values.length > 0) {
        options.push({ type: 'effort', values: option.values });
      }
    } else {
      const min = option.min ?? MIN_THINKING_BUDGET;
      // Thinking tokens come out of the same budget as the answer, so the
      // model's output ceiling is the natural bound when none is published.
      const max = option.max ?? outputLimit;
      if (max !== null && max > min) options.push({ type: 'budget_tokens', min, max });
    }
  }
  return options;
}

function toCatalogModel(
  raw: z.infer<typeof modelSchema>,
  defaults: ModelDefaults = NO_DEFAULTS
): AgentCatalogModel {
  const outputLimit = raw.limit?.output ?? null;
  const reasoning = toReasoningOptions(raw, outputLimit);
  const cost =
    raw.cost?.input !== undefined && raw.cost.output !== undefined
      ? { input: raw.cost.input, output: raw.cost.output }
      : null;
  // An effort the capability catalog does not list would render as a default
  // the user cannot see, let alone choose.
  const efforts = reasoning.find((option) => option.type === 'effort')?.values ?? [];
  const defaultEffort =
    defaults.reasoningEffort !== null && efforts.includes(defaults.reasoningEffort)
      ? defaults.reasoningEffort
      : null;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? null,
    contextLimit: raw.limit?.context ?? null,
    outputLimit,
    supportsTools: raw.tool_call ?? false,
    supportsTemperature: raw.temperature ?? false,
    inputImage: raw.modalities?.input?.includes('image') ?? false,
    outputImage: raw.modalities?.output?.includes('image') ?? false,
    reasoning,
    cost,
    releaseDate: raw.release_date ?? null,
    defaultTemperature: defaults.temperature,
    defaultReasoningEnabled: defaults.reasoningEnabled,
    defaultReasoningEffort: defaultEffort
  };
}

/** The values of an enum parameter, or `[]` when the model has no such knob. */
function enumValues(
  params: Record<string, z.infer<typeof imageParameterSchema>> | undefined,
  name: string
): string[] {
  const param = params?.[name];
  return param?.type === 'enum' ? param.values : [];
}

function toImageModel(raw: z.infer<typeof imageModelSchema>): AgentImageModel {
  const params = raw.supported_parameters;
  const references = params?.input_references;
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    description: raw.description ?? null,
    resolutions: enumValues(params, 'resolution'),
    qualities: enumValues(params, 'quality'),
    aspectRatios: enumValues(params, 'aspect_ratio'),
    seed: params?.seed !== undefined,
    maxReferences: references?.type === 'range' ? references.max : 0,
    streams: raw.supports_streaming ?? false
  };
}

/**
 * The OpenRouter slice of the models.dev catalog, annotated with OpenRouter's
 * published defaults and cached on disk so the agent settings tab opens
 * instantly and still works offline. Refreshed once a day, or on demand.
 *
 * Carries the images register in the same file and on the same schedule. It is
 * a second endpoint rather than a second view of the first, but from the user's
 * side it is one list of models with one Refresh button, and splitting the
 * cache would only mean two of them going stale independently.
 */
export class AgentModelCatalog {
  private memo: Cached | null = null;

  constructor(
    private readonly cacheFile: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Cached models, refreshed when stale or when `force` is set. */
  async list(force = false): Promise<AgentCatalog> {
    const cached = this.memo ?? (await this.readCache());
    if (cached) this.memo = cached;

    const fresh = cached !== null && Date.now() - cached.fetchedAt < REFRESH_AFTER_MS;
    if (fresh && !force) return { ...cached, source: 'cache', error: null };

    try {
      const [models, imageModels] = await this.download();
      this.memo = { fetchedAt: Date.now(), models, imageModels };
      await this.writeCache(this.memo);
      return { ...this.memo, source: 'network', error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed refresh must not take the settings tab down with it - serve
      // whatever was cached and let the UI mention the staleness.
      if (cached) return { ...cached, source: 'cache', error: message };
      return { models: [], imageModels: [], fetchedAt: 0, source: 'none', error: message };
    }
  }

  /**
   * What the images endpoint says about a model, from whatever has already been
   * downloaded. Deliberately not a `Promise`: this is asked while a turn is
   * being assembled, and the answer is worth having only if it is free. Nothing
   * cached yet ⇒ `null`, and the caller falls back to asking for nothing in
   * particular - which is what every call did before this list existed.
   */
  cachedImageModel(id: string): AgentImageModel | null {
    return this.memo?.imageModels.find((model) => model.id === id) ?? null;
  }

  private async download(): Promise<[AgentCatalogModel[], AgentImageModel[]]> {
    const [catalog, defaults, imageModels] = await Promise.all([
      this.downloadCatalog(),
      this.downloadDefaults(),
      this.downloadImageModels()
    ]);
    const models: AgentCatalogModel[] = [];
    for (const entry of Object.values(catalog)) {
      const model = modelSchema.safeParse(entry);
      if (model.success) {
        models.push(toCatalogModel(model.data, defaults.get(model.data.id) ?? NO_DEFAULTS));
      }
    }
    if (models.length === 0) throw new Error('models.dev returned no usable OpenRouter models');
    return [models.sort((a, b) => a.id.localeCompare(b.id)), imageModels];
  }

  /**
   * Every model the images endpoint will run. Unlike the defaults above this is
   * not best effort: an empty list here is indistinguishable from "image
   * generation is unavailable", so a failure fails the refresh and the last good
   * cache is served with the reason attached.
   */
  private async downloadImageModels(): Promise<AgentImageModel[]> {
    const res = await this.fetchImpl(OPENROUTER_IMAGES_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`OpenRouter responded ${res.status} for image models`);
    const parsed = imagesResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('Unexpected response shape from the images endpoint');
    const models: AgentImageModel[] = [];
    for (const entry of parsed.data.data) {
      // One at a time, like the catalog above: an odd entry costs us that model
      // rather than the whole list.
      const model = imageModelSchema.safeParse(entry);
      if (model.success) models.push(toImageModel(model.data));
    }
    if (models.length === 0) throw new Error('OpenRouter returned no usable image models');
    return models.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async downloadCatalog(): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!res.ok) throw new Error(`models.dev responded ${res.status}`);
    const parsed = catalogResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error('Unexpected response shape from models.dev');
    return parsed.data.openrouter.models;
  }

  /**
   * Per-model defaults, best effort: this list is a nicety on top of the
   * capability catalog, so a failure here leaves the models unannotated rather
   * than taking the catalog down.
   */
  private async downloadDefaults(): Promise<Map<string, ModelDefaults>> {
    const defaults = new Map<string, ModelDefaults>();
    try {
      const res = await this.fetchImpl(OPENROUTER_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) return defaults;
      const parsed = openRouterDefaultsSchema.safeParse(await res.json());
      if (!parsed.success) return defaults;
      for (const entry of parsed.data.data) {
        defaults.set(entry.id, {
          temperature: entry.default_parameters?.temperature ?? null,
          reasoningEnabled: entry.reasoning?.default_enabled ?? null,
          reasoningEffort: entry.reasoning?.default_effort ?? null
        });
      }
    } catch {
      // Offline, or OpenRouter is down - fall through with an empty map.
    }
    return defaults;
  }

  private async readCache(): Promise<Cached | null> {
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(await readFile(this.cacheFile, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async writeCache(data: Cached): Promise<void> {
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify(data), 'utf8');
    } catch {
      // A cache we cannot write is a slower settings tab, not a failure.
    }
  }
}
