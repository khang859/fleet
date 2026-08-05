import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import { z } from 'zod';
import type {
  AgentCatalog,
  AgentCatalogModel,
  AgentReasoningOption
} from '../../shared/agent-types';

const CATALOG_URL = 'https://models.dev/api.json';
/**
 * models.dev describes what a model *can* do but publishes no defaults, so the
 * numbers a parameter falls back to come from OpenRouter's own model list.
 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
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
  )
});

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

/**
 * The OpenRouter slice of the models.dev catalog, annotated with OpenRouter's
 * published defaults and cached on disk so the agent settings tab opens
 * instantly and still works offline. Refreshed once a day, or on demand.
 */
export class AgentModelCatalog {
  private memo: { fetchedAt: number; models: AgentCatalogModel[] } | null = null;

  constructor(
    private readonly cacheFile: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Cached models, refreshed when stale or when `force` is set. */
  async list(force = false): Promise<AgentCatalog> {
    const cached = this.memo ?? (await this.readCache());
    if (cached) this.memo = cached;

    const fresh = cached !== null && Date.now() - cached.fetchedAt < REFRESH_AFTER_MS;
    if (fresh && !force) {
      return { models: cached.models, fetchedAt: cached.fetchedAt, source: 'cache', error: null };
    }

    try {
      const models = await this.download();
      const fetchedAt = Date.now();
      this.memo = { fetchedAt, models };
      await this.writeCache(this.memo);
      return { models, fetchedAt, source: 'network', error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A failed refresh must not take the settings tab down with it - serve
      // whatever was cached and let the UI mention the staleness.
      if (cached) {
        return {
          models: cached.models,
          fetchedAt: cached.fetchedAt,
          source: 'cache',
          error: message
        };
      }
      return { models: [], fetchedAt: 0, source: 'none', error: message };
    }
  }

  private async download(): Promise<AgentCatalogModel[]> {
    const [catalog, defaults] = await Promise.all([
      this.downloadCatalog(),
      this.downloadDefaults()
    ]);
    const models: AgentCatalogModel[] = [];
    for (const entry of Object.values(catalog)) {
      const model = modelSchema.safeParse(entry);
      if (model.success) {
        models.push(toCatalogModel(model.data, defaults.get(model.data.id) ?? NO_DEFAULTS));
      }
    }
    if (models.length === 0) throw new Error('models.dev returned no usable OpenRouter models');
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

  private async readCache(): Promise<{ fetchedAt: number; models: AgentCatalogModel[] } | null> {
    try {
      const parsed = cacheSchema.safeParse(JSON.parse(await readFile(this.cacheFile, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async writeCache(data: {
    fetchedAt: number;
    models: AgentCatalogModel[];
  }): Promise<void> {
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(this.cacheFile, JSON.stringify(data), 'utf8');
    } catch {
      // A cache we cannot write is a slower settings tab, not a failure.
    }
  }
}
