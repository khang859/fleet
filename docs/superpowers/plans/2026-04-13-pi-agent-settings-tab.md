# Pi Agent Settings Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pi Agent" section to Fleet's Settings page that manages pi-coding-agent's custom providers, models, and core defaults, writing to `~/.pi/agent/settings.json` and `~/.pi/agent/models.json` with merge-safe round-trips.

**Architecture:** Main process owns all pi config I/O through a new `PiConfigManager` class. Zod `.passthrough()` schemas preserve unknown fields on read/write. IPC is exposed on the renderer as `window.fleet.piConfig.*`. Renderer adds a new Settings section (`PiSection`) composed of four subsections: Defaults, Built-in Providers (read-only), Custom Providers, and Footer.

**Tech Stack:** Electron 39, React 19, Zod 4.3, Vitest 4.1, TypeScript 5.9, Tailwind 4.

**Spec:** `docs/superpowers/specs/2026-04-13-pi-agent-settings-tab-design.md`

---

## File Structure

**New files:**

| Path                                                                 | Responsibility                                                                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/pi-config-types.ts`                                      | Zod schemas + inferred types (`PiSettings`, `PiProvider`, `PiModel`, `PiApiKey`, `BuiltInProviderStatus`, `ModelEntry`, `PiModelsFile`) + `parseApiKeyString` / `serializeApiKey` helpers |
| `src/shared/pi-presets.ts`                                           | Hand-maintained preset table (bedrock, ollama, lm-studio, openrouter, vercel-gateway, custom)                                                                                             |
| `src/main/pi-config-manager.ts`                                      | File I/O for `~/.pi/agent/settings.json` and `~/.pi/agent/models.json`, merge+atomic write, per-file async lock, opens config folder                                                      |
| `src/main/pi-auth-inspector.ts`                                      | Read-only `auth.json` probe + env-var detection for built-in provider status; loads pi's built-in model catalog                                                                           |
| `src/main/__tests__/pi-config-manager.test.ts`                       | Tests for read/write/merge/lock/atomic-write                                                                                                                                              |
| `src/main/__tests__/pi-auth-inspector.test.ts`                       | Tests for auth.json parsing + env-var detection                                                                                                                                           |
| `src/shared/__tests__/pi-config-types.test.ts`                       | Tests for schema passthrough + apiKey parsing helpers                                                                                                                                     |
| `src/renderer/src/components/settings/pi/PiSection.tsx`              | Entry point; loads data; renders 4 subsections                                                                                                                                            |
| `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx`         | Default provider, default model, thinking level, theme, enabledModels                                                                                                                     |
| `src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx` | Read-only status rows                                                                                                                                                                     |
| `src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx`  | Add button + collapsible cards                                                                                                                                                            |
| `src/renderer/src/components/settings/pi/PiProviderForm.tsx`         | Shared edit form                                                                                                                                                                          |
| `src/renderer/src/components/settings/pi/PiPresetPicker.tsx`         | Modal preset picker                                                                                                                                                                       |
| `src/renderer/src/components/settings/pi/PiApiKeyInput.tsx`          | Discriminated apiKey control                                                                                                                                                              |
| `src/renderer/src/components/settings/pi/PiModelsEditor.tsx`         | Row editor for models[]                                                                                                                                                                   |

**Modified files:**

| Path                                                   | Change                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| `src/shared/ipc-channels.ts`                           | Add `PI_CONFIG_*` channel constants                                  |
| `src/main/ipc-handlers.ts`                             | Register `PiConfigManager` handlers; accept it in function signature |
| `src/main/index.ts`                                    | Instantiate `PiConfigManager` and pass to `registerIpcHandlers`      |
| `src/preload/index.ts`                                 | Expose `piConfig` namespace on `window.fleet`                        |
| `src/renderer/src/components/settings/SettingsNav.tsx` | Add `'pi'` to `SettingsSection` union + nav entry                    |
| `src/renderer/src/components/settings/SettingsTab.tsx` | Register `pi: PiSection` in `SECTION_COMPONENTS`                     |

---

## Task 1: Zod schemas and `apiKey` parsing helpers

**Files:**

- Create: `src/shared/pi-config-types.ts`
- Test: `src/shared/__tests__/pi-config-types.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/__tests__/pi-config-types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  PiSettingsSchema,
  PiModelsFileSchema,
  parseApiKeyString,
  serializeApiKey
} from '../pi-config-types';

describe('PiSettingsSchema', () => {
  it('parses minimal object', () => {
    const out = PiSettingsSchema.parse({});
    expect(out).toEqual({});
  });

  it('preserves unknown fields via passthrough', () => {
    const input = {
      defaultProvider: 'anthropic',
      compaction: { enabled: true, reserveTokens: 16384 },
      customField: 'preserved'
    };
    const out = PiSettingsSchema.parse(input);
    expect(out).toMatchObject(input);
  });

  it('rejects invalid thinking level', () => {
    expect(() => PiSettingsSchema.parse({ defaultThinkingLevel: 'extreme' })).toThrow();
  });
});

describe('PiModelsFileSchema', () => {
  it('defaults providers to empty object', () => {
    const out = PiModelsFileSchema.parse({});
    expect(out.providers).toEqual({});
  });

  it('preserves unknown provider fields', () => {
    const input = {
      providers: {
        ollama: {
          baseUrl: 'http://localhost:11434/v1',
          api: 'openai-completions' as const,
          unknownField: 42,
          models: [{ id: 'llama3.1:8b', extra: 'keep' }]
        }
      }
    };
    const out = PiModelsFileSchema.parse(input);
    expect(out.providers.ollama).toMatchObject({ unknownField: 42 });
    expect(out.providers.ollama.models?.[0]).toMatchObject({ extra: 'keep' });
  });
});

describe('parseApiKeyString', () => {
  it('detects shell command by leading !', () => {
    expect(parseApiKeyString('!security find-generic-password -ws anthropic')).toEqual({
      kind: 'shell',
      command: 'security find-generic-password -ws anthropic'
    });
  });

  it('detects env var from SCREAMING_SNAKE_CASE', () => {
    expect(parseApiKeyString('ANTHROPIC_API_KEY')).toEqual({
      kind: 'envVar',
      name: 'ANTHROPIC_API_KEY'
    });
  });

  it('treats literal-looking values as literal', () => {
    expect(parseApiKeyString('sk-ant-abc123')).toEqual({ kind: 'literal', value: 'sk-ant-abc123' });
  });

  it('treats empty/undefined as undefined', () => {
    expect(parseApiKeyString(undefined)).toBeUndefined();
    expect(parseApiKeyString('')).toBeUndefined();
  });
});

describe('serializeApiKey', () => {
  it('serializes shell with leading !', () => {
    expect(serializeApiKey({ kind: 'shell', command: 'op read foo' })).toBe('!op read foo');
  });

  it('serializes envVar as name', () => {
    expect(serializeApiKey({ kind: 'envVar', name: 'MY_KEY' })).toBe('MY_KEY');
  });

  it('serializes literal as value', () => {
    expect(serializeApiKey({ kind: 'literal', value: 'sk-123' })).toBe('sk-123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/__tests__/pi-config-types.test.ts`
Expected: FAIL with "Cannot find module '../pi-config-types'"

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/pi-config-types.ts`:

```ts
import { z } from 'zod';

export const PiThinkingLevelSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/shared/__tests__/pi-config-types.test.ts`
Expected: PASS (all 10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/shared/pi-config-types.ts src/shared/__tests__/pi-config-types.test.ts
git commit -m "feat(pi): add Zod schemas and apiKey helpers for pi config"
```

---

## Task 2: Preset table

**Files:**

- Create: `src/shared/pi-presets.ts`

No tests — this is a static data table.

- [ ] **Step 1: Create the preset table**

Create `src/shared/pi-presets.ts`:

```ts
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
    hint: "Bedrock uses the AWS SDK credential chain. Set AWS_REGION and AWS_PROFILE (or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) in your shell. Custom models here are added alongside pi's built-in Bedrock models."
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
  {
    id: 'anthropic',
    label: 'Anthropic',
    envVar: 'ANTHROPIC_API_KEY',
    supportsOAuth: true,
    hint: 'Run `pi` and `/login` to authenticate with a Claude Pro/Max subscription.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    envVar: 'OPENAI_API_KEY',
    supportsOAuth: true,
    hint: 'Run `pi` and `/login` for ChatGPT Plus/Pro (Codex) subscription.'
  },
  {
    id: 'google',
    label: 'Google Gemini',
    envVar: 'GOOGLE_API_KEY',
    supportsOAuth: true,
    hint: 'Run `pi` and `/login` for Gemini CLI subscription.'
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    envVar: 'AWS_REGION',
    hint: 'Uses AWS SDK credential chain. Set AWS_REGION and AWS_PROFILE.'
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    envVar: 'AZURE_OPENAI_API_KEY',
    hint: 'Set AZURE_OPENAI_API_KEY and AZURE_OPENAI_ENDPOINT.'
  },
  {
    id: 'vertex',
    label: 'Google Vertex',
    envVar: 'GOOGLE_APPLICATION_CREDENTIALS',
    hint: 'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON path.'
  },
  { id: 'mistral', label: 'Mistral', envVar: 'MISTRAL_API_KEY' },
  { id: 'groq', label: 'Groq', envVar: 'GROQ_API_KEY' },
  { id: 'cerebras', label: 'Cerebras', envVar: 'CEREBRAS_API_KEY' },
  { id: 'xai', label: 'xAI', envVar: 'XAI_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY' },
  { id: 'huggingface', label: 'Hugging Face', envVar: 'HF_TOKEN' },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    supportsOAuth: true,
    hint: 'Run `pi` and `/login` for GitHub Copilot.'
  }
];
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck:node`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/pi-presets.ts
git commit -m "feat(pi): add preset table for provider templates"
```

---

## Task 3: `PiConfigManager` — read path with merge-safe parsing

**Files:**

- Create: `src/main/pi-config-manager.ts`
- Test: `src/main/__tests__/pi-config-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/pi-config-manager.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/pi-config-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/main/pi-config-manager.ts`:

```ts
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { shell } from 'electron';
import { createLogger } from './logger';
import {
  PiSettingsSchema,
  PiModelsFileSchema,
  type PiSettings,
  type PiProvider,
  type PiModelsFile
} from '../shared/pi-config-types';

const log = createLogger('pi-config-manager');

export class PiConfigParseError extends Error {
  constructor(
    public readonly file: string,
    public readonly originalMessage: string,
    public readonly rawSnippet?: string
  ) {
    super(`Failed to parse ${file}: ${originalMessage}`);
    this.name = 'PiConfigParseError';
  }
}

export class PiConfigValidationError extends Error {
  constructor(
    public readonly file: string,
    public readonly issues: Array<{ path: string; message: string }>
  ) {
    super(`Invalid ${file}: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'PiConfigValidationError';
  }
}

type PiConfigManagerOptions = {
  configDir?: string;
};

export class PiConfigManager {
  private readonly configDir: string;
  private readonly settingsPath: string;
  private readonly modelsPath: string;
  private readonly authPath: string;
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(opts: PiConfigManagerOptions = {}) {
    this.configDir = opts.configDir ?? join(homedir(), '.pi', 'agent');
    this.settingsPath = join(this.configDir, 'settings.json');
    this.modelsPath = join(this.configDir, 'models.json');
    this.authPath = join(this.configDir, 'auth.json');
  }

  getConfigDir(): string {
    return this.configDir;
  }

  getAuthPath(): string {
    return this.authPath;
  }

  async readSettings(): Promise<PiSettings> {
    return this.readParsed(this.settingsPath, 'settings.json', (raw) =>
      PiSettingsSchema.parse(raw)
    );
  }

  async readModels(): Promise<PiModelsFile> {
    return this.readParsed(this.modelsPath, 'models.json', (raw) =>
      PiModelsFileSchema.parse(raw ?? {})
    );
  }

  async openConfigFolder(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
    await shell.openPath(this.configDir);
  }

  private async readParsed<T>(
    path: string,
    fileLabel: string,
    parse: (raw: unknown) => T
  ): Promise<T> {
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return parse(fileLabel === 'models.json' ? { providers: {} } : {});
      }
      throw err;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new PiConfigParseError(fileLabel, msg, text.slice(0, 200));
    }

    try {
      return parse(raw);
    } catch (err: unknown) {
      const issues =
        err &&
        typeof err === 'object' &&
        'issues' in err &&
        Array.isArray((err as { issues: unknown[] }).issues)
          ? (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues.map(
              (i) => ({ path: i.path.join('.'), message: i.message })
            )
          : [{ path: '', message: err instanceof Error ? err.message : String(err) }];
      throw new PiConfigValidationError(fileLabel, issues);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/__tests__/pi-config-manager.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/pi-config-manager.ts src/main/__tests__/pi-config-manager.test.ts
git commit -m "feat(pi): add PiConfigManager read path with zod passthrough"
```

---

## Task 4: `PiConfigManager` — write path with merge, atomic write, and per-file lock

**Files:**

- Modify: `src/main/pi-config-manager.ts`
- Modify: `src/main/__tests__/pi-config-manager.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/main/__tests__/pi-config-manager.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/pi-config-manager.test.ts`
Expected: FAIL — `writeSettings`, `writeProvider`, `deleteProvider`, `renameProvider` not defined.

- [ ] **Step 3: Extend `PiConfigManager`**

Add to `src/main/pi-config-manager.ts` (after the existing methods, before the closing brace):

```ts
  async writeSettings(patch: Partial<PiSettings>): Promise<void> {
    await this.withLock(this.settingsPath, async () => {
      const current = await this.readSettings();
      const merged = { ...current, ...patch };
      await this.atomicWriteJson(this.settingsPath, merged);
    });
  }

  async writeProvider(id: string, provider: PiProvider): Promise<void> {
    await this.withLock(this.modelsPath, async () => {
      const current = await this.readModels();
      const providers = { ...current.providers, [id]: provider };
      await this.atomicWriteJson(this.modelsPath, { ...current, providers });
    });
  }

  async deleteProvider(id: string): Promise<void> {
    await this.withLock(this.modelsPath, async () => {
      const current = await this.readModels();
      if (!(id in current.providers)) return;
      const providers = { ...current.providers };
      delete providers[id];
      await this.atomicWriteJson(this.modelsPath, { ...current, providers });
    });
  }

  async renameProvider(oldId: string, newId: string): Promise<void> {
    if (oldId === newId) return;
    await this.withLock(this.modelsPath, async () => {
      const current = await this.readModels();
      const value = current.providers[oldId];
      if (!value) return;
      const providers = { ...current.providers, [newId]: value };
      delete providers[oldId];
      await this.atomicWriteJson(this.modelsPath, { ...current, providers });
    });
  }

  private async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLocks.get(path) ?? Promise.resolve();
    let resolveNext!: () => void;
    const next = new Promise<void>((r) => (resolveNext = r));
    this.writeLocks.set(
      path,
      prev.then(() => next)
    );
    try {
      await prev;
      return await fn();
    } finally {
      resolveNext();
      if (this.writeLocks.get(path) === prev.then(() => next)) {
        this.writeLocks.delete(path);
      }
    }
  }

  private async atomicWriteJson(path: string, obj: unknown): Promise<void> {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const tmp = `${path}.tmp`;
    const text = `${JSON.stringify(obj, null, 2)}\n`;
    await writeFile(tmp, text, 'utf-8');
    await rename(tmp, path);
    log.debug('wrote pi config', { path });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/pi-config-manager.test.ts`
Expected: PASS (all 13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/pi-config-manager.ts src/main/__tests__/pi-config-manager.test.ts
git commit -m "feat(pi): add merge-safe write path with per-file lock and atomic rename"
```

---

## Task 5: `PiAuthInspector` — built-in provider auth + model catalog

**Files:**

- Create: `src/main/pi-auth-inspector.ts`
- Test: `src/main/__tests__/pi-auth-inspector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/__tests__/pi-auth-inspector.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiAuthInspector } from '../pi-auth-inspector';

function makeDir(): string {
  const d = join(
    tmpdir(),
    `fleet-pi-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(d, { recursive: true });
  return d;
}

describe('PiAuthInspector.getBuiltInStatus', () => {
  let dir: string;
  const realEnv = { ...process.env };

  beforeEach(() => {
    dir = makeDir();
    for (const k of Object.keys(process.env)) {
      if (
        k.endsWith('_API_KEY') ||
        k.startsWith('AWS_') ||
        k.startsWith('GOOGLE_') ||
        k.startsWith('AZURE_') ||
        k === 'HF_TOKEN'
      ) {
        delete process.env[k];
      }
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...realEnv };
  });

  it('marks all providers as Not configured when no auth and no env', async () => {
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    for (const p of list) {
      expect(p.authenticated).toBe(false);
      expect(p.method).toBe('none');
    }
  });

  it('detects env-var-based auth', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    const anthropic = list.find((p) => p.id === 'anthropic');
    expect(anthropic?.authenticated).toBe(true);
    expect(anthropic?.method).toBe('env-var');
    expect(anthropic?.envVarName).toBe('ANTHROPIC_API_KEY');
  });

  it('detects OAuth-based auth from auth.json', async () => {
    writeFileSync(
      join(dir, 'auth.json'),
      JSON.stringify({
        anthropic: { oauth: { access_token: 'tok', expires_at: Date.now() + 3600_000 } }
      })
    );
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    const anthropic = list.find((p) => p.id === 'anthropic');
    expect(anthropic?.authenticated).toBe(true);
    expect(anthropic?.method).toBe('oauth');
  });

  it('falls back to Not configured when auth.json is unreadable', async () => {
    writeFileSync(join(dir, 'auth.json'), 'not json');
    const insp = new PiAuthInspector({ authPath: join(dir, 'auth.json') });
    const list = await insp.getBuiltInStatus();
    expect(list.every((p) => !p.authenticated || p.method === 'env-var')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/__tests__/pi-auth-inspector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/main/pi-auth-inspector.ts`:

```ts
import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger';
import { PI_BUILT_IN_PROVIDERS } from '../shared/pi-presets';
import type { BuiltInProviderStatus, ModelEntry } from '../shared/pi-config-types';

const log = createLogger('pi-auth-inspector');

type PiAuthInspectorOptions = {
  authPath?: string;
  /** Path to installed pi's models.generated.ts for the model catalog, if available. */
  modelCatalogPath?: string;
};

export class PiAuthInspector {
  private readonly authPath: string;
  private readonly modelCatalogPath?: string;

  constructor(opts: PiAuthInspectorOptions = {}) {
    this.authPath = opts.authPath ?? join(homedir(), '.pi', 'agent', 'auth.json');
    this.modelCatalogPath = opts.modelCatalogPath;
  }

  async getBuiltInStatus(): Promise<BuiltInProviderStatus[]> {
    const authMap = await this.readAuthMap();
    return PI_BUILT_IN_PROVIDERS.map((p) => {
      const auth = authMap[p.id];
      if (auth && typeof auth === 'object' && 'oauth' in auth) {
        return {
          id: p.id,
          label: p.label,
          authenticated: true,
          method: 'oauth' as const,
          envVarName: p.envVar,
          hint: p.hint
        };
      }
      if (p.envVar && process.env[p.envVar]) {
        return {
          id: p.id,
          label: p.label,
          authenticated: true,
          method: 'env-var' as const,
          envVarName: p.envVar,
          hint: p.hint
        };
      }
      return {
        id: p.id,
        label: p.label,
        authenticated: false,
        method: 'none' as const,
        envVarName: p.envVar,
        hint: p.hint
      };
    });
  }

  async listAvailableModels(): Promise<ModelEntry[]> {
    if (!this.modelCatalogPath) return [];
    try {
      const text = await readFile(this.modelCatalogPath, 'utf-8');
      const match = text.match(/MODELS\s*=\s*(\[[\s\S]*?\]);/);
      if (!match) return [];
      const parsed = JSON.parse(match[1]) as Array<{
        provider?: string;
        id?: string;
        name?: string;
      }>;
      return parsed
        .filter(
          (m): m is { provider: string; id: string; name?: string } =>
            typeof m.provider === 'string' && typeof m.id === 'string'
        )
        .map((m) => ({
          providerId: m.provider,
          modelId: m.id,
          label: m.name ?? m.id
        }));
    } catch (err) {
      log.debug('model catalog unavailable', {
        err: err instanceof Error ? err.message : String(err)
      });
      return [];
    }
  }

  private async readAuthMap(): Promise<Record<string, unknown>> {
    try {
      const text = await readFile(this.authPath, 'utf-8');
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/pi-auth-inspector.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/main/pi-auth-inspector.ts src/main/__tests__/pi-auth-inspector.test.ts
git commit -m "feat(pi): add PiAuthInspector for built-in provider status"
```

---

## Task 6: IPC channel constants

**Files:**

- Modify: `src/shared/ipc-channels.ts`

- [ ] **Step 1: Add the channel constants**

Modify `src/shared/ipc-channels.ts` by appending inside the object literal (after the existing `PI_CHECK_UPDATES` line):

```ts
  PI_CONFIG_READ_SETTINGS: 'pi:config:read-settings',
  PI_CONFIG_WRITE_SETTINGS: 'pi:config:write-settings',
  PI_CONFIG_READ_MODELS: 'pi:config:read-models',
  PI_CONFIG_WRITE_PROVIDER: 'pi:config:write-provider',
  PI_CONFIG_DELETE_PROVIDER: 'pi:config:delete-provider',
  PI_CONFIG_RENAME_PROVIDER: 'pi:config:rename-provider',
  PI_CONFIG_BUILT_IN_STATUS: 'pi:config:built-in-status',
  PI_CONFIG_LIST_MODELS: 'pi:config:list-models',
  PI_CONFIG_OPEN_FOLDER: 'pi:config:open-folder'
```

Make sure the last existing `PI_CHECK_UPDATES` entry has a trailing comma so the new lines parse.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat(pi): add pi config IPC channel constants"
```

---

## Task 7: Wire `PiConfigManager` + `PiAuthInspector` in main process

**Files:**

- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Add imports at the top of `src/main/index.ts`**

Add (alongside the existing `PiAgentManager` import):

```ts
import { PiConfigManager } from './pi-config-manager';
import { PiAuthInspector } from './pi-auth-inspector';
import { homedir } from 'os';
import { join } from 'path';
```

(The file already imports `join` and `homedir` in some spots — if those imports already exist, don't duplicate them.)

- [ ] **Step 2: Instantiate the two services**

In `src/main/index.ts`, find the line `const piAgentManager = new PiAgentManager();` (near line 59) and add, immediately after it:

```ts
const piConfigManager = new PiConfigManager();
const piAuthInspector = new PiAuthInspector({
  modelCatalogPath: join(
    homedir(),
    '.fleet',
    'agents',
    'pi',
    'node_modules',
    '@mariozechner',
    'pi-ai',
    'src',
    'models.generated.ts'
  )
});
```

- [ ] **Step 3: Extend the `registerIpcHandlers(...)` call**

Find the existing call (currently around lines 286–303) and replace its body to add the two new trailing arguments:

```ts
registerIpcHandlers(
  ptyManager,
  layoutStore,
  eventBus,
  notificationDetector,
  notificationState,
  settingsStore,
  cwdPoller,
  gitService,
  () => mainWindow,
  workspacePath,
  activityTracker,
  new WorktreeService(),
  annotationStore,
  annotateService,
  piAgentManager,
  fleetBridge,
  piConfigManager,
  piAuthInspector
);
```

- [ ] **Step 4: Extend `registerIpcHandlers` signature and add handlers**

Modify `src/main/ipc-handlers.ts`. Add to the imports block:

```ts
import type { PiConfigManager } from './pi-config-manager';
import { PiConfigParseError, PiConfigValidationError } from './pi-config-manager';
import type { PiAuthInspector } from './pi-auth-inspector';
import type { PiProvider, PiSettings } from '../shared/pi-config-types';
```

Extend the function signature:

```ts
export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  notificationDetector: NotificationDetector,
  notificationState: NotificationStateManager,
  settingsStore: SettingsStore,
  cwdPoller: CwdPoller,
  gitService: GitService,
  getWindow: () => BrowserWindow | null,
  workspacePath: string,
  activityTracker: ActivityTracker,
  worktreeService: WorktreeService,
  annotationStore: AnnotationStore,
  annotateService: AnnotateService,
  piAgentManager: PiAgentManager,
  fleetBridge: FleetBridgeServer,
  piConfigManager: PiConfigManager,
  piAuthInspector: PiAuthInspector
): void {
```

Add new handlers anywhere in the function body (e.g. after the existing pi agent handlers). The `toPiConfigError` helper normalizes our custom errors into a serializable shape:

```ts
function toPiConfigError(err: unknown): Error {
  if (err instanceof PiConfigParseError) {
    const e = new Error(err.message);
    e.name = 'PiConfigParseError';
    Object.assign(e, { file: err.file, rawSnippet: err.rawSnippet });
    return e;
  }
  if (err instanceof PiConfigValidationError) {
    const e = new Error(err.message);
    e.name = 'PiConfigValidationError';
    Object.assign(e, { file: err.file, issues: err.issues });
    return e;
  }
  return toError(err);
}

ipcMain.handle(IPC_CHANNELS.PI_CONFIG_READ_SETTINGS, async () => {
  try {
    return await piConfigManager.readSettings();
  } catch (err) {
    throw toPiConfigError(err);
  }
});

ipcMain.handle(
  IPC_CHANNELS.PI_CONFIG_WRITE_SETTINGS,
  async (_event, patch: Partial<PiSettings>) => {
    try {
      await piConfigManager.writeSettings(patch);
    } catch (err) {
      throw toPiConfigError(err);
    }
  }
);

ipcMain.handle(IPC_CHANNELS.PI_CONFIG_READ_MODELS, async () => {
  try {
    return await piConfigManager.readModels();
  } catch (err) {
    throw toPiConfigError(err);
  }
});

ipcMain.handle(
  IPC_CHANNELS.PI_CONFIG_WRITE_PROVIDER,
  async (_event, payload: { id: string; provider: PiProvider }) => {
    try {
      await piConfigManager.writeProvider(payload.id, payload.provider);
    } catch (err) {
      throw toPiConfigError(err);
    }
  }
);

ipcMain.handle(IPC_CHANNELS.PI_CONFIG_DELETE_PROVIDER, async (_event, id: string) => {
  try {
    await piConfigManager.deleteProvider(id);
  } catch (err) {
    throw toPiConfigError(err);
  }
});

ipcMain.handle(
  IPC_CHANNELS.PI_CONFIG_RENAME_PROVIDER,
  async (_event, payload: { oldId: string; newId: string }) => {
    try {
      await piConfigManager.renameProvider(payload.oldId, payload.newId);
    } catch (err) {
      throw toPiConfigError(err);
    }
  }
);

ipcMain.handle(IPC_CHANNELS.PI_CONFIG_BUILT_IN_STATUS, async () => {
  return piAuthInspector.getBuiltInStatus();
});

ipcMain.handle(IPC_CHANNELS.PI_CONFIG_LIST_MODELS, async () => {
  return piAuthInspector.listAvailableModels();
});

ipcMain.handle(IPC_CHANNELS.PI_CONFIG_OPEN_FOLDER, async () => {
  await piConfigManager.openConfigFolder();
});
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Run full main-process test suite**

Run: `npx vitest run src/main`
Expected: all existing tests still pass plus the new ones.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat(pi): wire PiConfigManager and PiAuthInspector into IPC"
```

---

## Task 8: Expose `window.fleet.piConfig.*` in preload

**Files:**

- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add imports**

Near the top of `src/preload/index.ts`, add to the `pi-config-types` imports (create the import if missing):

```ts
import type {
  PiSettings,
  PiProvider,
  PiModelsFile,
  BuiltInProviderStatus,
  ModelEntry
} from '../shared/pi-config-types';
```

- [ ] **Step 2: Add the `piConfig` namespace**

In `fleetApi`, directly after the existing `pi: { ... }` block (before the closing brace of `fleetApi`), insert:

```ts
  piConfig: {
    readSettings: async (): Promise<PiSettings> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_READ_SETTINGS),
    writeSettings: async (patch: Partial<PiSettings>): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_WRITE_SETTINGS, patch),
    readModels: async (): Promise<PiModelsFile> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_READ_MODELS),
    writeProvider: async (id: string, provider: PiProvider): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_WRITE_PROVIDER, { id, provider }),
    deleteProvider: async (id: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_DELETE_PROVIDER, id),
    renameProvider: async (oldId: string, newId: string): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_RENAME_PROVIDER, { oldId, newId }),
    getBuiltInStatus: async (): Promise<BuiltInProviderStatus[]> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_BUILT_IN_STATUS),
    listAvailableModels: async (): Promise<ModelEntry[]> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_LIST_MODELS),
    openConfigFolder: async (): Promise<void> =>
      typedInvoke(IPC_CHANNELS.PI_CONFIG_OPEN_FOLDER)
  }
```

Add a trailing comma after the `pi: { ... }` block if needed.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(pi): expose piConfig namespace on window.fleet"
```

---

## Task 9: Register the nav entry and empty `PiSection`

**Files:**

- Modify: `src/renderer/src/components/settings/SettingsNav.tsx`
- Modify: `src/renderer/src/components/settings/SettingsTab.tsx`
- Create: `src/renderer/src/components/settings/pi/PiSection.tsx`

- [ ] **Step 1: Add `'pi'` to the union and nav list**

Modify `src/renderer/src/components/settings/SettingsNav.tsx`. Change the union:

```ts
export type SettingsSection =
  | 'general'
  | 'notifications'
  | 'socket'
  | 'visualizer'
  | 'updates'
  | 'copilot'
  | 'annotate'
  | 'pi';
```

And in `ALL_SECTIONS`, insert after the `copilot` entry:

```ts
  { id: 'pi', label: 'Pi Agent' },
```

- [ ] **Step 2: Register the section component**

Modify `src/renderer/src/components/settings/SettingsTab.tsx`:

Add the import:

```ts
import { PiSection } from './pi/PiSection';
```

Add to `SECTION_COMPONENTS`:

```ts
  pi: PiSection,
```

- [ ] **Step 3: Create a minimal `PiSection` that proves the plumbing**

Create `src/renderer/src/components/settings/pi/PiSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type {
  PiSettings,
  PiModelsFile,
  BuiltInProviderStatus,
  PiConfigError
} from '../../../../../shared/pi-config-types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; settings: PiSettings; models: PiModelsFile; builtIn: BuiltInProviderStatus[] }
  | { kind: 'error'; message: string };

export function PiSection(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [settings, models, builtIn] = await Promise.all([
          window.fleet.piConfig.readSettings(),
          window.fleet.piConfig.readModels(),
          window.fleet.piConfig.getBuiltInStatus()
        ]);
        if (!alive) return;
        setState({ kind: 'ready', settings, models, builtIn });
      } catch (err) {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      }
    };
    void load();
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (state.kind === 'loading') {
    return <div className="text-sm text-neutral-400">Loading pi configuration…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded bg-red-900/30 border border-red-700/50 px-3 py-2 text-sm text-red-300">
        Failed to read pi config: {state.message}
        <button
          onClick={() => void window.fleet.piConfig.openConfigFolder()}
          className="ml-2 underline"
        >
          Open config folder
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl text-neutral-100 font-semibold">Pi Agent</h1>
      <p className="text-sm text-neutral-500">
        Configure pi-coding-agent. Writes to <code>~/.pi/agent/</code>; changes apply to both
        Fleet&apos;s pi tabs and your CLI pi.
      </p>
      <PiConfigStub settings={state.settings} models={state.models} builtIn={state.builtIn} />
      <footer className="pt-4 border-t border-neutral-800 text-xs text-neutral-500 flex justify-between">
        <span>
          Pi CLI writes the same files. If <code>pi</code> is open, save from one side at a time.
        </span>
        <button
          onClick={() => void window.fleet.piConfig.openConfigFolder()}
          className="underline hover:text-neutral-300"
        >
          Open config folder
        </button>
      </footer>
    </div>
  );
}

function PiConfigStub({
  settings,
  models,
  builtIn
}: {
  settings: PiSettings;
  models: PiModelsFile;
  builtIn: BuiltInProviderStatus[];
}): React.JSX.Element {
  return (
    <pre className="text-xs text-neutral-400 bg-neutral-900 rounded p-3 overflow-x-auto">
      {JSON.stringify({ settings, providerIds: Object.keys(models.providers), builtIn }, null, 2)}
    </pre>
  );
}

// Avoid unused import warning until Task 10 uses PiConfigError
void (undefined as unknown as PiConfigError);
```

- [ ] **Step 4: Typecheck and run dev**

Run: `npm run typecheck:web`
Expected: PASS

Optional manual check: `npm run dev`, open Settings, click "Pi Agent" in nav. You should see the loading → JSON dump of current config.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/SettingsNav.tsx src/renderer/src/components/settings/SettingsTab.tsx src/renderer/src/components/settings/pi/PiSection.tsx
git commit -m "feat(pi): register Pi Agent settings section skeleton"
```

---

## Task 10: `PiDefaultsForm`

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx`
- Modify: `src/renderer/src/components/settings/pi/PiSection.tsx`

- [ ] **Step 1: Create the component**

Create `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { SettingRow } from '../SettingRow';
import type {
  PiSettings,
  PiModelsFile,
  PiThinkingLevel,
  ModelEntry
} from '../../../../../shared/pi-config-types';

type Props = {
  settings: PiSettings;
  models: PiModelsFile;
  modelCatalog: ModelEntry[];
  builtInProviderIds: string[];
  onChange: (patch: Partial<PiSettings>) => void | Promise<void>;
};

const THINKING_LEVELS: PiThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export function PiDefaultsForm({
  settings,
  models,
  modelCatalog,
  builtInProviderIds,
  onChange
}: Props): React.JSX.Element {
  const [enabledModelsText, setEnabledModelsText] = useState(
    (settings.enabledModels ?? []).join('\n')
  );

  const providerIds = useMemo(() => {
    const customIds = Object.keys(models.providers);
    return [...new Set([...builtInProviderIds, ...customIds])].sort();
  }, [models, builtInProviderIds]);

  const modelsForProvider = useMemo(() => {
    const fromCatalog = modelCatalog
      .filter((m) => m.providerId === settings.defaultProvider)
      .map((m) => ({ id: m.modelId, label: m.label }));
    const fromCustom = (models.providers[settings.defaultProvider ?? '']?.models ?? []).map(
      (m) => ({ id: m.id, label: m.name ?? m.id })
    );
    return [...fromCustom, ...fromCatalog];
  }, [modelCatalog, models, settings.defaultProvider]);

  const commitEnabledModels = (): void => {
    const lines = enabledModelsText
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    void onChange({ enabledModels: lines.length ? lines : undefined });
  };

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold text-neutral-200">Defaults</h2>

      <div>
        <SettingRow label="Default provider">
          <select
            value={settings.defaultProvider ?? ''}
            onChange={(e) =>
              void onChange({
                defaultProvider: e.target.value || undefined,
                defaultModel: undefined
              })
            }
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          >
            <option value="">(none)</option>
            {providerIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div>
        <SettingRow label="Default model">
          {modelsForProvider.length > 0 ? (
            <select
              value={settings.defaultModel ?? ''}
              onChange={(e) => void onChange({ defaultModel: e.target.value || undefined })}
              className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
            >
              <option value="">(none)</option>
              {modelsForProvider.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={settings.defaultModel ?? ''}
              onChange={(e) => void onChange({ defaultModel: e.target.value || undefined })}
              placeholder="Model id"
              className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-64"
            />
          )}
        </SettingRow>
      </div>

      <div>
        <SettingRow label="Thinking level">
          <select
            value={settings.defaultThinkingLevel ?? ''}
            onChange={(e) =>
              void onChange({
                defaultThinkingLevel: (e.target.value || undefined) as PiThinkingLevel | undefined
              })
            }
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          >
            <option value="">(default)</option>
            {THINKING_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>

      <div>
        <SettingRow label="Theme">
          <input
            type="text"
            value={settings.theme ?? ''}
            onChange={(e) => void onChange({ theme: e.target.value || undefined })}
            placeholder="dark"
            className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 w-40"
          />
        </SettingRow>
      </div>

      <div>
        <label className="text-sm text-neutral-300 block mb-1">Model cycling (Ctrl+P)</label>
        <textarea
          value={enabledModelsText}
          onChange={(e) => setEnabledModelsText(e.target.value)}
          onBlur={commitEnabledModels}
          rows={4}
          placeholder={'claude-*\ngpt-4o\ngemini-2*'}
          className="w-full bg-neutral-800 text-xs font-mono text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        <p className="text-xs text-neutral-500 mt-1">
          One pattern per line. Matches model ids or names.
        </p>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Use the component in `PiSection`**

Modify `src/renderer/src/components/settings/pi/PiSection.tsx`. Replace the `PiConfigStub` rendering (and its definition) with:

```tsx
import { PiDefaultsForm } from './PiDefaultsForm';
import { PI_BUILT_IN_PROVIDERS } from '../../../../../shared/pi-presets';
import type { ModelEntry } from '../../../../../shared/pi-config-types';
```

Then inside the component, after the `if (state.kind === 'error')` branch and before the return, add:

```tsx
const [modelCatalog, setModelCatalog] = useState<ModelEntry[]>([]);
useEffect(() => {
  void window.fleet.piConfig.listAvailableModels().then(setModelCatalog);
}, []);
```

Note: useState/useEffect for modelCatalog must be declared at the top of the component alongside the existing state (hooks can't run conditionally). Move them up to the top:

```tsx
export function PiSection(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [modelCatalog, setModelCatalog] = useState<ModelEntry[]>([]);

  useEffect(() => {
    void window.fleet.piConfig.listAvailableModels().then(setModelCatalog);
  }, []);

  // ...rest unchanged up to the final return
```

Update the ready-state return to use `PiDefaultsForm`:

```tsx
return (
  <div className="space-y-8">
    <h1 className="text-xl text-neutral-100 font-semibold">Pi Agent</h1>
    <p className="text-sm text-neutral-500">
      Configure pi-coding-agent. Writes to <code>~/.pi/agent/</code>; changes apply to both
      Fleet&apos;s pi tabs and your CLI pi.
    </p>

    <PiDefaultsForm
      settings={state.settings}
      models={state.models}
      modelCatalog={modelCatalog}
      builtInProviderIds={PI_BUILT_IN_PROVIDERS.map((p) => p.id)}
      onChange={async (patch) => {
        await window.fleet.piConfig.writeSettings(patch);
        const next = await window.fleet.piConfig.readSettings();
        setState((s) => (s.kind === 'ready' ? { ...s, settings: next } : s));
      }}
    />

    <footer className="pt-4 border-t border-neutral-800 text-xs text-neutral-500 flex justify-between">
      <span>
        Pi CLI writes the same files. If <code>pi</code> is open, save from one side at a time.
      </span>
      <button
        onClick={() => void window.fleet.piConfig.openConfigFolder()}
        className="underline hover:text-neutral-300"
      >
        Open config folder
      </button>
    </footer>
  </div>
);
```

Remove the `PiConfigStub` function and the dummy `void (undefined as unknown as PiConfigError)` line.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 4: Manual check**

Run: `npm run dev`
Open Settings → Pi Agent. Change thinking level and theme. Confirm values survive a refresh of the tab (switch away and back).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/pi/
git commit -m "feat(pi): add PiDefaultsForm for pi settings.json defaults"
```

---

## Task 11: `PiBuiltInProvidersList`

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx`
- Modify: `src/renderer/src/components/settings/pi/PiSection.tsx`

- [ ] **Step 1: Create the component**

Create `src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx`:

```tsx
import type { BuiltInProviderStatus } from '../../../../../shared/pi-config-types';

type Props = { items: BuiltInProviderStatus[] };

export function PiBuiltInProvidersList({ items }: Props): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-neutral-200">Built-in Providers</h2>
      <p className="text-xs text-neutral-500">
        Status is read-only. Run <code>pi</code> and use <code>/login</code> for OAuth providers, or
        set env vars for API-key providers.
      </p>
      <ul className="divide-y divide-neutral-800 border border-neutral-800 rounded">
        {items.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <span
              className={`w-2 h-2 rounded-full ${
                p.authenticated ? 'bg-green-500' : 'bg-neutral-600'
              }`}
            />
            <span className="text-sm text-neutral-200 min-w-[140px]">{p.label}</span>
            <span className="text-xs text-neutral-500 flex-1">
              {p.method === 'oauth' && 'Authenticated via OAuth'}
              {p.method === 'env-var' && p.envVarName && `${p.envVarName} set`}
              {p.method === 'none' &&
                (p.envVarName
                  ? `Not configured (set ${p.envVarName} or run /login)`
                  : 'Not configured')}
            </span>
            {p.hint && (
              <span className="text-xs text-neutral-600" title={p.hint}>
                ?
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 2: Render it in `PiSection`**

In `PiSection.tsx`, import and render between `PiDefaultsForm` and the footer:

```tsx
import { PiBuiltInProvidersList } from './PiBuiltInProvidersList';
```

```tsx
<PiBuiltInProvidersList items={state.builtIn} />
```

- [ ] **Step 3: Manual check**

Run: `npm run dev`
Open Settings → Pi Agent. Verify the list shows providers and correctly reflects whether `ANTHROPIC_API_KEY` (or any other env var) is set in the shell that launched Fleet.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx src/renderer/src/components/settings/pi/PiSection.tsx
git commit -m "feat(pi): add read-only built-in providers list"
```

---

## Task 12: `PiApiKeyInput` and `PiModelsEditor`

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiApiKeyInput.tsx`
- Create: `src/renderer/src/components/settings/pi/PiModelsEditor.tsx`

- [ ] **Step 1: Create `PiApiKeyInput`**

Create `src/renderer/src/components/settings/pi/PiApiKeyInput.tsx`:

```tsx
import type { PiApiKey } from '../../../../../shared/pi-config-types';

type Props = {
  value: PiApiKey | undefined;
  onChange: (next: PiApiKey | undefined) => void;
};

const KINDS: Array<{ kind: PiApiKey['kind']; label: string; placeholder: string; help: string }> = [
  {
    kind: 'envVar',
    label: 'Env var',
    placeholder: 'MY_API_KEY',
    help: 'Reads process.env[name] at request time.'
  },
  {
    kind: 'literal',
    label: 'Literal',
    placeholder: 'sk-...',
    help: 'Stored in plain text in models.json.'
  },
  {
    kind: 'shell',
    label: 'Shell cmd',
    placeholder: 'security find-generic-password -ws anthropic',
    help: 'Runs the command and uses stdout.'
  }
];

export function PiApiKeyInput({ value, onChange }: Props): React.JSX.Element {
  const kind = value?.kind ?? 'envVar';
  const current = KINDS.find((k) => k.kind === kind)!;

  const text =
    value === undefined
      ? ''
      : value.kind === 'envVar'
        ? value.name
        : value.kind === 'literal'
          ? value.value
          : value.command;

  const handleTextChange = (raw: string): void => {
    if (!raw) {
      onChange(undefined);
      return;
    }
    if (kind === 'envVar') onChange({ kind: 'envVar', name: raw });
    else if (kind === 'literal') onChange({ kind: 'literal', value: raw });
    else onChange({ kind: 'shell', command: raw });
  };

  const handleKindChange = (nextKind: PiApiKey['kind']): void => {
    if (nextKind === kind) return;
    if (!text) {
      onChange(undefined);
      return;
    }
    if (nextKind === 'envVar') onChange({ kind: 'envVar', name: text });
    else if (nextKind === 'literal') onChange({ kind: 'literal', value: text });
    else onChange({ kind: 'shell', command: text });
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-0 rounded overflow-hidden border border-neutral-700 w-fit">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => handleKindChange(k.kind)}
            className={`px-2 py-1 text-xs ${
              k.kind === kind
                ? 'bg-neutral-700 text-neutral-100'
                : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <input
        type={kind === 'literal' ? 'password' : 'text'}
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
        placeholder={current.placeholder}
        className="w-full bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
      />
      <p className="text-xs text-neutral-500">{current.help}</p>
      {kind === 'literal' && (
        <p className="text-xs text-amber-400/80">
          ⚠ Stored in plain text in <code>~/.pi/agent/models.json</code>.
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `PiModelsEditor`**

Create `src/renderer/src/components/settings/pi/PiModelsEditor.tsx`:

```tsx
import type { PiModel } from '../../../../../shared/pi-config-types';

type Props = {
  models: PiModel[];
  onChange: (next: PiModel[]) => void;
};

export function PiModelsEditor({ models, onChange }: Props): React.JSX.Element {
  const update = (index: number, patch: Partial<PiModel>): void => {
    const next = models.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange(next);
  };
  const remove = (index: number): void => onChange(models.filter((_, i) => i !== index));
  const add = (): void => onChange([...models, { id: '' }]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-neutral-400">Models</label>
        <button
          type="button"
          onClick={add}
          className="text-xs px-2 py-0.5 bg-neutral-700 hover:bg-neutral-600 rounded border border-neutral-600 text-neutral-200"
        >
          + Add model
        </button>
      </div>

      {models.length === 0 && (
        <p className="text-xs text-neutral-600 italic">No models. Add at least one.</p>
      )}

      <div className="space-y-1">
        {models.map((m, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_90px_90px_auto_auto] gap-2 items-center text-xs"
          >
            <input
              type="text"
              value={m.id}
              onChange={(e) => update(i, { id: e.target.value })}
              placeholder="model-id"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200 font-mono"
            />
            <input
              type="text"
              value={m.name ?? ''}
              onChange={(e) => update(i, { name: e.target.value || undefined })}
              placeholder="Display name"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200"
            />
            <input
              type="number"
              value={m.contextWindow ?? ''}
              onChange={(e) =>
                update(i, { contextWindow: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="ctx"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200"
            />
            <input
              type="number"
              value={m.maxTokens ?? ''}
              onChange={(e) =>
                update(i, { maxTokens: e.target.value ? Number(e.target.value) : undefined })
              }
              placeholder="max"
              className="bg-neutral-800 rounded px-2 py-1 border border-neutral-700 text-neutral-200"
            />
            <label className="flex items-center gap-1 text-neutral-400">
              <input
                type="checkbox"
                checked={m.reasoning ?? false}
                onChange={(e) => update(i, { reasoning: e.target.checked || undefined })}
              />
              reason
            </label>
            <button
              type="button"
              onClick={() => remove(i)}
              className="text-neutral-500 hover:text-red-400 px-1"
              aria-label="Remove model"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiApiKeyInput.tsx src/renderer/src/components/settings/pi/PiModelsEditor.tsx
git commit -m "feat(pi): add PiApiKeyInput and PiModelsEditor components"
```

---

## Task 13: `PiProviderForm`

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiProviderForm.tsx`

- [ ] **Step 1: Create the form**

Create `src/renderer/src/components/settings/pi/PiProviderForm.tsx`:

```tsx
import { useState } from 'react';
import {
  parseApiKeyString,
  serializeApiKey,
  type PiApi,
  type PiApiKey,
  type PiProvider
} from '../../../../../shared/pi-config-types';
import { getPreset, type PiPresetId } from '../../../../../shared/pi-presets';
import { PiApiKeyInput } from './PiApiKeyInput';
import { PiModelsEditor } from './PiModelsEditor';

type Props = {
  initialId: string;
  initialProvider: PiProvider;
  presetId: PiPresetId;
  existingIds: string[];
  onSave: (id: string, provider: PiProvider) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onCancel: () => void;
};

const APIS: PiApi[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
];

export function PiProviderForm({
  initialId,
  initialProvider,
  presetId,
  existingIds,
  onSave,
  onDelete,
  onCancel
}: Props): React.JSX.Element {
  const preset = getPreset(presetId);

  const [id, setId] = useState(initialId);
  const [baseUrl, setBaseUrl] = useState(initialProvider.baseUrl ?? '');
  const [api, setApi] = useState<PiApi | ''>(initialProvider.api ?? '');
  const [apiKey, setApiKey] = useState<PiApiKey | undefined>(
    parseApiKeyString(initialProvider.apiKey)
  );
  const [compatText, setCompatText] = useState(() =>
    initialProvider.compat ? JSON.stringify(initialProvider.compat, null, 2) : ''
  );
  const [compatError, setCompatError] = useState<string | null>(null);
  const [models, setModels] = useState(initialProvider.models ?? []);

  const duplicateId = id !== initialId && existingIds.includes(id);
  const idValid = id.trim().length > 0 && !duplicateId;

  const parseCompatOrNull = (): Record<string, unknown> | undefined | 'error' => {
    if (!compatText.trim()) return undefined;
    try {
      const parsed: unknown = JSON.parse(compatText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return 'error';
    } catch {
      return 'error';
    }
  };

  const handleSave = async (): Promise<void> => {
    const compat = parseCompatOrNull();
    if (compat === 'error') {
      setCompatError('Must be a JSON object.');
      return;
    }
    setCompatError(null);

    const next: PiProvider = {
      ...initialProvider, // preserves unknown fields like headers the UI doesn't edit
      baseUrl: baseUrl || undefined,
      api: api || undefined,
      apiKey: preset.skipApiKey || !apiKey ? undefined : serializeApiKey(apiKey),
      compat,
      models: models.length ? models : undefined
    };
    await onSave(id.trim(), next);
  };

  return (
    <div className="space-y-3 p-3 border-t border-neutral-700/50">
      {preset.hint && (
        <div className="rounded bg-neutral-800/60 border border-neutral-700 px-2 py-1.5 text-xs text-neutral-300">
          {preset.hint}
        </div>
      )}

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Provider id</label>
        <input
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          className="w-64 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        {duplicateId && (
          <p className="text-xs text-red-400 mt-1">A provider with this id already exists.</p>
        )}
      </div>

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Base URL</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className="w-full bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
      </div>

      <div>
        <label className="text-xs text-neutral-400 block mb-1">API</label>
        <select
          value={api}
          onChange={(e) => setApi((e.target.value || '') as PiApi | '')}
          className="bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        >
          <option value="">(default)</option>
          {APIS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {!preset.skipApiKey && (
        <div>
          <label className="text-xs text-neutral-400 block mb-1">API key</label>
          <PiApiKeyInput value={apiKey} onChange={setApiKey} />
        </div>
      )}

      <div>
        <label className="text-xs text-neutral-400 block mb-1">Compat (advanced, JSON)</label>
        <textarea
          value={compatText}
          onChange={(e) => {
            setCompatText(e.target.value);
            setCompatError(null);
          }}
          rows={4}
          placeholder='{ "supportsDeveloperRole": false }'
          className="w-full bg-neutral-800 text-xs font-mono text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        {compatError && <p className="text-xs text-red-400 mt-1">{compatError}</p>}
      </div>

      <PiModelsEditor models={models} onChange={setModels} />

      <div className="flex justify-between pt-2">
        <button
          type="button"
          onClick={() => void onDelete()}
          className="px-2 py-1 text-xs rounded border border-red-700/50 text-red-400 hover:bg-red-900/30"
        >
          Delete provider
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-sm rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!idValid}
            onClick={() => void handleSave()}
            className="px-3 py-1 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiProviderForm.tsx
git commit -m "feat(pi): add PiProviderForm for editing custom providers"
```

---

## Task 14: `PiPresetPicker` and `PiCustomProvidersList`

**Files:**

- Create: `src/renderer/src/components/settings/pi/PiPresetPicker.tsx`
- Create: `src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx`

- [ ] **Step 1: Create `PiPresetPicker`**

Create `src/renderer/src/components/settings/pi/PiPresetPicker.tsx`:

```tsx
import { PI_PRESETS, type PiPresetId } from '../../../../../shared/pi-presets';

type Props = {
  onPick: (id: PiPresetId) => void;
  onClose: () => void;
};

export function PiPresetPicker({ onPick, onClose }: Props): React.JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="max-w-lg w-full bg-neutral-900 border border-neutral-700 rounded p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-neutral-100">Add Provider</h3>
        <p className="text-xs text-neutral-500">Pick a preset — you can edit everything after.</p>
        <div className="grid grid-cols-2 gap-2">
          {PI_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.id)}
              className="text-left p-3 border border-neutral-700 rounded hover:border-blue-500 hover:bg-neutral-800"
            >
              <div className="text-sm text-neutral-200">{p.label}</div>
              <div className="text-xs text-neutral-500 mt-1">{p.description}</div>
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-sm rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `PiCustomProvidersList`**

Create `src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx`:

```tsx
import { useMemo, useState } from 'react';
import type { PiModelsFile, PiProvider } from '../../../../../shared/pi-config-types';
import { getPreset, type PiPresetId, PI_PRESETS } from '../../../../../shared/pi-presets';
import { PiProviderForm } from './PiProviderForm';
import { PiPresetPicker } from './PiPresetPicker';

type Draft = {
  existingId: string | null; // null = new, unsaved
  presetId: PiPresetId;
  id: string;
  provider: PiProvider;
};

type Props = {
  models: PiModelsFile;
  onWrite: (id: string, provider: PiProvider) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onReload: () => Promise<void>;
};

function inferPresetId(id: string, provider: PiProvider): PiPresetId {
  if (
    id === 'bedrock' ||
    (provider.api === 'anthropic-messages' && (id.includes('bedrock') || id === 'bedrock'))
  ) {
    return 'bedrock';
  }
  const url = provider.baseUrl ?? '';
  if (url.includes('11434')) return 'ollama';
  if (url.includes('1234')) return 'lm-studio';
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('ai-gateway.vercel.sh')) return 'vercel-gateway';
  return 'custom';
}

export function PiCustomProvidersList({
  models,
  onWrite,
  onDelete,
  onReload
}: Props): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pickerOpen, setPickerOpen] = useState(false);

  const existingIds = useMemo(() => Object.keys(models.providers), [models]);

  const startEdit = (id: string): void => {
    const provider = models.providers[id];
    setDrafts((d) => ({
      ...d,
      [id]: { existingId: id, presetId: inferPresetId(id, provider), id, provider }
    }));
  };

  const startAdd = (presetId: PiPresetId): void => {
    setPickerOpen(false);
    const preset = getPreset(presetId);
    let baseId = preset.defaultProviderId;
    let i = 1;
    while (existingIds.includes(baseId) || baseId in drafts) {
      baseId = `${preset.defaultProviderId}-${i++}`;
    }
    setDrafts((d) => ({
      ...d,
      [`__new__${baseId}`]: {
        existingId: null,
        presetId,
        id: baseId,
        provider: { ...preset.defaults }
      }
    }));
  };

  const cancelDraft = (draftKey: string): void => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[draftKey];
      return next;
    });
  };

  const saveDraft = async (draftKey: string, id: string, provider: PiProvider): Promise<void> => {
    const draft = drafts[draftKey];
    if (!draft) return;
    if (draft.existingId && draft.existingId !== id) {
      await onDelete(draft.existingId);
    }
    await onWrite(id, provider);
    await onReload();
    cancelDraft(draftKey);
  };

  const deleteDraft = async (draftKey: string): Promise<void> => {
    const draft = drafts[draftKey];
    if (!draft) return;
    if (draft.existingId) {
      const ok = window.confirm(`Delete provider "${draft.existingId}"?`);
      if (!ok) return;
      await onDelete(draft.existingId);
      await onReload();
    }
    cancelDraft(draftKey);
  };

  const orderedEntries = useMemo(
    () => Object.entries(models.providers).sort(([a], [b]) => a.localeCompare(b)),
    [models]
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-200">Custom Providers</h2>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white"
        >
          + Add Provider
        </button>
      </div>

      {orderedEntries.length === 0 &&
        Object.values(drafts).every((d) => d.existingId === null && false) && (
          <p className="text-xs text-neutral-600 italic">
            No custom providers yet. Add one to configure AWS Bedrock, Ollama, proxies, etc.
          </p>
        )}

      <div className="space-y-2">
        {orderedEntries.map(([id, provider]) => {
          const draftKey = id;
          const draft = drafts[draftKey];
          const presetId = inferPresetId(id, provider);
          const presetLabel = PI_PRESETS.find((p) => p.id === presetId)?.label ?? 'Custom';
          const modelCount = provider.models?.length ?? 0;

          return (
            <div key={id} className="border border-neutral-700 rounded">
              <div className="flex items-center justify-between px-3 py-2">
                <div className="flex items-center gap-2 text-sm text-neutral-200">
                  <span className="font-mono">{id}</span>
                  <span className="text-xs text-neutral-500 rounded bg-neutral-800 px-1.5 py-0.5">
                    {presetLabel}
                  </span>
                  <span className="text-xs text-neutral-500">
                    {modelCount} model{modelCount === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="flex gap-2">
                  {!draft && (
                    <button
                      type="button"
                      onClick={() => startEdit(id)}
                      className="text-xs px-2 py-0.5 border border-neutral-700 rounded text-neutral-300 hover:bg-neutral-800"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
              {draft && (
                <PiProviderForm
                  initialId={draft.id}
                  initialProvider={draft.provider}
                  presetId={draft.presetId}
                  existingIds={existingIds.filter((eid) => eid !== draft.existingId)}
                  onSave={(nid, np) => saveDraft(draftKey, nid, np)}
                  onDelete={() => deleteDraft(draftKey)}
                  onCancel={() => cancelDraft(draftKey)}
                />
              )}
            </div>
          );
        })}

        {Object.entries(drafts)
          .filter(([, d]) => d.existingId === null)
          .map(([draftKey, draft]) => (
            <div key={draftKey} className="border border-blue-700/50 rounded">
              <div className="px-3 py-2 text-sm text-neutral-200 flex items-center gap-2">
                <span className="font-mono">{draft.id}</span>
                <span className="text-xs text-blue-400 rounded bg-blue-900/30 px-1.5 py-0.5">
                  new
                </span>
              </div>
              <PiProviderForm
                initialId={draft.id}
                initialProvider={draft.provider}
                presetId={draft.presetId}
                existingIds={existingIds}
                onSave={(nid, np) => saveDraft(draftKey, nid, np)}
                onDelete={() => cancelDraft(draftKey)}
                onCancel={() => cancelDraft(draftKey)}
              />
            </div>
          ))}
      </div>

      {pickerOpen && <PiPresetPicker onPick={startAdd} onClose={() => setPickerOpen(false)} />}
    </section>
  );
}
```

- [ ] **Step 3: Wire into `PiSection`**

In `src/renderer/src/components/settings/pi/PiSection.tsx`, import and render between `PiBuiltInProvidersList` and the footer:

```tsx
import { PiCustomProvidersList } from './PiCustomProvidersList';
```

```tsx
<PiCustomProvidersList
  models={state.models}
  onWrite={(id, provider) => window.fleet.piConfig.writeProvider(id, provider)}
  onDelete={(id) => window.fleet.piConfig.deleteProvider(id)}
  onReload={async () => {
    const next = await window.fleet.piConfig.readModels();
    setState((s) => (s.kind === 'ready' ? { ...s, models: next } : s));
  }}
/>
```

- [ ] **Step 4: Typecheck and manual smoke**

Run: `npm run typecheck:web`
Expected: PASS

Run: `npm run dev`
Open Settings → Pi Agent. Click "+ Add Provider", pick "Ollama (local)". Verify the card appears with pre-filled baseUrl, add a model id, click Save. Open `~/.pi/agent/models.json` in Finder and verify the entry was written. Click Edit on an existing provider, change the apiKey kind, Save.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/settings/pi/PiPresetPicker.tsx src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx src/renderer/src/components/settings/pi/PiSection.tsx
git commit -m "feat(pi): add custom providers list with preset picker"
```

---

## Task 15: Verification pass

**Files:** none modified; this task is verification only.

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS. Fix any violations inline before continuing.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: PASS. No regressions.

- [ ] **Step 4: Manual UI smoke on a throwaway config**

Set `export HOME=/tmp/fleet-pi-smoke` (fresh dir), start `npm run dev`, and verify:

1. Opening Settings → Pi Agent on a fresh home shows no error banner (missing files handled).
2. Changing the default provider writes `~/.pi/agent/settings.json` with exactly that field.
3. Adding an Ollama provider writes `~/.pi/agent/models.json`; adding a second provider preserves the first.
4. Hand-edit `~/.pi/agent/settings.json` to add an unknown field (`"xyz": 42`), switch away and back (window focus re-reads); change the thinking level; verify the unknown field survived.
5. Corrupt `~/.pi/agent/models.json` to `{ not json`. Reload the tab. Confirm the error banner appears with an "Open config folder" link.

Restore `HOME` when done.

- [ ] **Step 5: Commit verification notes (only if changes were needed)**

If Steps 1–4 required fixes, commit them now:

```bash
git add -A
git commit -m "chore(pi): fix-up from verification pass"
```

If no changes were needed, skip this step.

---

## Task 16: Changelog entry

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add unreleased section entry**

Add under the most-recent `## [Unreleased]` block (or create one if missing):

```markdown
### Added

- Settings → Pi Agent tab: configure default provider/model/thinking level/theme, view built-in provider auth status, and add/edit/delete custom providers (Amazon Bedrock, Ollama, LM Studio, OpenRouter, Vercel AI Gateway, generic OpenAI-compatible) backed by `~/.pi/agent/{settings,models}.json`. Writes preserve unknown fields via Zod passthrough.
```

- [ ] **Step 2: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add Pi Agent settings tab to changelog"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement                                                      | Implemented in   |
| --------------------------------------------------------------------- | ---------------- |
| `'pi'` nav entry after Copilot                                        | Task 9           |
| Defaults subsection (provider, model, thinking, theme, enabledModels) | Task 10          |
| Built-in providers read-only list                                     | Task 11          |
| Custom providers list + Add + Edit + Delete                           | Task 14          |
| Preset picker (6 entries)                                             | Task 2 + Task 14 |
| Bedrock preset skips apiKey, shows AWS env-var hint                   | Task 2 + Task 13 |
| Ollama / LM Studio / OpenRouter / Vercel Gateway / Custom presets     | Task 2           |
| `PiApiKeyInput` segmented control with plaintext warning              | Task 12          |
| `PiModelsEditor` with id/name/ctx/max/reasoning                       | Task 12          |
| Zod passthrough on settings + models                                  | Task 1           |
| `apiKey` parse/serialize helpers                                      | Task 1           |
| `PiConfigManager` read/write with merge                               | Task 3 + 4       |
| Atomic write (tmp + rename)                                           | Task 4           |
| Per-file async lock                                                   | Task 4           |
| `PiAuthInspector` with env-var + auth.json detection                  | Task 5           |
| Model catalog with graceful fallback                                  | Task 5           |
| IPC channels                                                          | Task 6           |
| Main-process wiring                                                   | Task 7           |
| Preload exposure on `window.fleet.piConfig`                           | Task 8           |
| Window focus re-read                                                  | Task 9           |
| Error banner on parse/validation errors                               | Task 9           |
| "Open config folder" action                                           | Task 3 + Task 9  |
| Concurrent-edit footer note                                           | Task 9           |
| Verification + changelog                                              | Task 15 + 16     |

**Placeholder scan:** No `TBD`, `TODO`, "implement later", or "similar to Task N" references. Every code step shows complete code.

**Type consistency:** `PiConfigManager.writeSettings(patch: Partial<PiSettings>)`, `writeProvider(id: string, provider: PiProvider)`, `deleteProvider(id: string)`, `renameProvider(oldId, newId)` match between the manager (Task 3/4), IPC handlers (Task 7), preload (Task 8), and renderer calls (Task 10/14). `PiApiKey` discriminated union is used consistently by `parseApiKeyString`/`serializeApiKey` (Task 1) and `PiApiKeyInput` (Task 12). `BuiltInProviderStatus` matches between inspector (Task 5) and list component (Task 11).

One item intentionally out of scope but worth noting: `PiConfigValidationError` is thrown from the main process but the renderer only shows `err.message` (Task 9). That's sufficient for v1 — the message already contains the offending field paths.
