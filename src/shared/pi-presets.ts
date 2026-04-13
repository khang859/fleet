import type { PiProvider } from './pi-config-types';

export type PiPresetId =
  | 'bedrock'
  | 'ollama'
  | 'lm-studio'
  | 'openrouter'
  | 'vercel-gateway'
  | 'custom';

export type PiPreset = {
  id: PiPresetId;
  label: string;
  description: string;
  /** Fleet's suggested provider key (user can override on save) */
  defaultProviderId: string;
  /** Partial provider pre-fill applied when the user picks this preset */
  defaults: PiProvider;
  /** Bedrock uses AWS SDK credential chain — no apiKey field in the form */
  skipApiKey?: boolean;
  /** Free-form hint shown at the top of the edit form */
  hint?: string;
};

export const PI_PRESETS: PiPreset[] = [
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    description: 'AWS-hosted Anthropic, Meta, Mistral models via the Bedrock API.',
    defaultProviderId: 'bedrock',
    defaults: {
      api: 'anthropic-messages'
    },
    skipApiKey: true,
    hint:
      'Bedrock uses the AWS SDK credential chain. Set AWS_REGION and AWS_PROFILE (or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) in your shell. Custom models here are added alongside pi\'s built-in Bedrock models.'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    description: 'Local models via Ollama at http://localhost:11434.',
    defaultProviderId: 'ollama',
    defaults: {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: 'ollama',
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false
      }
    }
  },
  {
    id: 'lm-studio',
    label: 'LM Studio (local)',
    description: 'Local models via LM Studio at http://localhost:1234.',
    defaultProviderId: 'lm-studio',
    defaults: {
      baseUrl: 'http://localhost:1234/v1',
      api: 'openai-completions',
      apiKey: 'lmstudio'
    }
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Unified API across many model providers.',
    defaultProviderId: 'openrouter',
    defaults: {
      baseUrl: 'https://openrouter.ai/api/v1',
      api: 'openai-completions',
      apiKey: 'OPENROUTER_API_KEY'
    }
  },
  {
    id: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    description: 'Route requests through Vercel AI Gateway.',
    defaultProviderId: 'vercel-gateway',
    defaults: {
      baseUrl: 'https://ai-gateway.vercel.sh/v1',
      api: 'openai-completions',
      apiKey: 'AI_GATEWAY_API_KEY'
    }
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    description: 'Generic OpenAI-compatible provider. Fill in everything.',
    defaultProviderId: 'custom-provider',
    defaults: {}
  }
];

export function getPreset(id: PiPresetId): PiPreset {
  const found = PI_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown preset: ${id}`);
  return found;
}

/** Known built-in providers pi supports (read-only in the UI). Keep synced with pi's catalog. */
export const PI_BUILT_IN_PROVIDERS: Array<{
  id: string;
  label: string;
  envVar?: string;
  supportsOAuth?: boolean;
  hint?: string;
}> = [
  { id: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY', supportsOAuth: true, hint: 'Run `pi` and `/login` to authenticate with a Claude Pro/Max subscription.' },
  { id: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY', supportsOAuth: true, hint: 'Run `pi` and `/login` for ChatGPT Plus/Pro (Codex) subscription.' },
  { id: 'google', label: 'Google Gemini', envVar: 'GOOGLE_API_KEY', supportsOAuth: true, hint: 'Run `pi` and `/login` for Gemini CLI subscription.' },
  { id: 'bedrock', label: 'Amazon Bedrock', envVar: 'AWS_REGION', hint: 'Uses AWS SDK credential chain. Set AWS_REGION and AWS_PROFILE.' },
  { id: 'azure', label: 'Azure OpenAI', envVar: 'AZURE_OPENAI_API_KEY', hint: 'Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT.' },
  { id: 'vertex', label: 'Google Vertex', envVar: 'GOOGLE_APPLICATION_CREDENTIALS', hint: 'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.' },
  { id: 'mistral', label: 'Mistral', envVar: 'MISTRAL_API_KEY' },
  { id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY' },
  { id: 'cerebras', label: 'Cerebras', envVar: 'CEREBRAS_API_KEY' },
  { id: 'xai', label: 'xAI', envVar: 'XAI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'huggingface', label: 'Hugging Face', envVar: 'HF_TOKEN' },
  { id: 'copilot', label: 'GitHub Copilot', supportsOAuth: true, hint: 'Run `pi` and `/login` for GitHub Copilot.' }
];
