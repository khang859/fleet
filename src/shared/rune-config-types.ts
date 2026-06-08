import { z } from 'zod';

// Mirrors rune's internal/config/settings.go and secrets.json. Schemas use
// `.passthrough()` so any key rune adds in future (or the user hand-edits)
// survives a Fleet read/write round-trip.

// ── Option constants (single source of truth for the UI dropdowns) ────────────
// These mirror rune's TUI "Grimoire of Settings" modal
// (internal/tui/modal/settings.go), which is the user-facing source of truth.

export const RUNE_PROVIDERS = ['codex', 'groq', 'ollama', 'runpod', 'openrouter'] as const;
export type RuneProvider = (typeof RUNE_PROVIDERS)[number];

export const RUNE_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh'] as const;
export const RUNE_ICON_MODES = ['auto', 'nerd', 'unicode', 'ascii'] as const;
export const RUNE_ACTIVITY_MODES = ['off', 'simple', 'arcane'] as const;
export const RUNE_SEARCH_ENABLED = ['auto', 'off', 'on'] as const;
export const RUNE_SEARCH_PROVIDERS = ['auto', 'brave', 'tavily', 'searxng'] as const;
export const RUNE_COMPACT_THRESHOLDS = [70, 80, 90] as const;
export const RUNE_SUBAGENT_CONCURRENCY = [1, 2, 4, 8] as const;
export const RUNE_SUBAGENT_TIMEOUTS = [30, 60, 120, 300, 600] as const;
export const RUNE_SUBAGENT_RETAIN = [25, 50, 100, 250] as const;

// secrets.json keys (plaintext API keys), in display order.
export const RUNE_SECRET_KEYS = [
  { key: 'groq_api_key', label: 'Groq API key' },
  { key: 'runpod_api_key', label: 'RunPod API key' },
  { key: 'openrouter_api_key', label: 'OpenRouter API key' },
  { key: 'brave_search_api_key', label: 'Brave Search API key' },
  { key: 'tavily_api_key', label: 'Tavily API key' }
] as const;

// Each provider's model field name in settings.json, so the UI can show a model
// input for the currently-selected provider.
export const RUNE_PROVIDER_MODEL_FIELD: Record<RuneProvider, keyof RuneSettings> = {
  codex: 'codex_model',
  groq: 'groq_model',
  ollama: 'ollama_model',
  runpod: 'runpod_model',
  openrouter: 'openrouter_model'
};

// ── Schemas ───────────────────────────────────────────────────────────────────

export const RuneProviderProfileSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    provider: z.string(),
    endpoint: z.string().optional(),
    model: z.string().optional(),
    // Pointers in Go (inherit vs explicit) → nullable+optional here.
    ollama_num_ctx: z.number().int().nullable().optional(),
    ollama_think: z.boolean().nullable().optional()
  })
  .passthrough();
export type RuneProviderProfile = z.infer<typeof RuneProviderProfileSchema>;

export const RuneAutoCompactSchema = z
  .object({
    enabled: z.boolean().optional(),
    threshold_pct: z.number().int().optional()
  })
  .passthrough();
export type RuneAutoCompact = z.infer<typeof RuneAutoCompactSchema>;

export const RuneWebSettingsSchema = z
  .object({
    fetch_enabled: z.boolean().optional(),
    fetch_allow_private: z.boolean().optional(),
    search_enabled: z.string().optional(),
    search_provider: z.string().optional()
  })
  .passthrough();
export type RuneWebSettings = z.infer<typeof RuneWebSettingsSchema>;

export const RuneSubagentSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_concurrent: z.number().int().optional(),
    default_timeout_secs: z.number().int().optional(),
    max_completed_retain: z.number().int().optional()
  })
  .passthrough();
export type RuneSubagentSettings = z.infer<typeof RuneSubagentSettingsSchema>;

export const RuneRepoMapSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    max_tokens: z.number().int().optional()
  })
  .passthrough();
export type RuneRepoMapSettings = z.infer<typeof RuneRepoMapSettingsSchema>;

export const RuneModelCapabilitiesSchema = z.object({ tools: z.string().optional() }).passthrough();

export const RuneSettingsSchema = z
  .object({
    provider: z.string().optional(),
    active_profile: z.string().optional(),
    profiles: z.array(RuneProviderProfileSchema).optional(),
    codex_model: z.string().optional(),
    groq_model: z.string().optional(),
    ollama_model: z.string().optional(),
    runpod_model: z.string().optional(),
    openrouter_model: z.string().optional(),
    ollama_endpoint: z.string().optional(),
    ollama_num_ctx: z.number().int().optional(),
    ollama_think: z.boolean().optional(),
    runpod_endpoint: z.string().optional(),
    openrouter_endpoint: z.string().optional(),
    reasoning_effort: z.string().optional(),
    icon_mode: z.string().optional(),
    activity_mode: z.string().optional(),
    auto_compact: RuneAutoCompactSchema.optional(),
    web: RuneWebSettingsSchema.optional(),
    subagents: RuneSubagentSettingsSchema.optional(),
    model_capabilities: z.record(z.string(), RuneModelCapabilitiesSchema).optional(),
    repo_map: RuneRepoMapSettingsSchema.optional()
  })
  .passthrough();
export type RuneSettings = z.infer<typeof RuneSettingsSchema>;

// secrets.json is a flat string→string map of API keys.
export const RuneSecretsSchema = z.record(z.string(), z.string());
export type RuneSecrets = z.infer<typeof RuneSecretsSchema>;
