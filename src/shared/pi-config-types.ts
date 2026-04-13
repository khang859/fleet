import { z } from 'zod';

export const PiThinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]);
export type PiThinkingLevel = z.infer<typeof PiThinkingLevelSchema>;

export const PiSettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultThinkingLevel: PiThinkingLevelSchema.optional(),
    theme: z.string().optional(),
    enabledModels: z.array(z.string()).optional()
  })
  .passthrough();
export type PiSettings = z.infer<typeof PiSettingsSchema>;

export const PiApiSchema = z.enum([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
]);
export type PiApi = z.infer<typeof PiApiSchema>;

export const PiModelSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(['text', 'image'])).optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    cost: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number()
      })
      .partial()
      .optional()
  })
  .passthrough();
export type PiModel = z.infer<typeof PiModelSchema>;

export const PiProviderSchema = z
  .object({
    baseUrl: z.string().optional(),
    api: PiApiSchema.optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    authHeader: z.boolean().optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
    models: z.array(PiModelSchema).optional(),
    modelOverrides: z.record(z.string(), PiModelSchema.partial()).optional()
  })
  .passthrough();
export type PiProvider = z.infer<typeof PiProviderSchema>;

export const PiModelsFileSchema = z
  .object({
    providers: z.record(z.string(), PiProviderSchema).default({})
  })
  .passthrough();
export type PiModelsFile = z.infer<typeof PiModelsFileSchema>;

export type PiApiKey =
  | { kind: 'literal'; value: string }
  | { kind: 'envVar'; name: string }
  | { kind: 'shell'; command: string };

const ENV_VAR_RE = /^[A-Z][A-Z0-9_]*$/;

export function parseApiKeyString(raw: string | undefined): PiApiKey | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('!')) {
    return { kind: 'shell', command: raw.slice(1) };
  }
  if (ENV_VAR_RE.test(raw)) {
    return { kind: 'envVar', name: raw };
  }
  return { kind: 'literal', value: raw };
}

export function serializeApiKey(key: PiApiKey): string {
  switch (key.kind) {
    case 'shell':
      return `!${key.command}`;
    case 'envVar':
      return key.name;
    case 'literal':
      return key.value;
  }
}

export type BuiltInProviderStatus = {
  id: string;
  label: string;
  authenticated: boolean;
  method: 'oauth' | 'env-var' | 'none';
  envVarName?: string;
  hint?: string;
};

export type ModelEntry = {
  providerId: string;
  modelId: string;
  label: string;
};

export type PiConfigErrorKind = 'parse' | 'validation' | 'io';

export type PiConfigError = {
  kind: PiConfigErrorKind;
  file: 'settings.json' | 'models.json' | 'auth.json';
  message: string;
  path?: string;
};
