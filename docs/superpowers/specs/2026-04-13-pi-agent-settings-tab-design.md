# Pi Agent Settings Tab Design

A new `Pi Agent` section on Fleet's Settings page that lets users configure the pi-coding-agent (providers, models, and core pi settings) through the UI instead of editing JSON by hand.

## Goals

- Let users manage pi's **custom providers and models** (Amazon Bedrock, Ollama, LM Studio, OpenRouter, Vercel AI Gateway, generic OpenAI-compatible) from Fleet's UI.
- Let users set pi's **basic defaults** (default provider/model, thinking level, theme, model-cycling list).
- Surface **auth status** for pi's built-in providers so users know what is and isn't authenticated.
- Preserve the existing contract that Fleet's pi and the user's CLI pi share one config directory (`~/.pi/agent/`).

## Non-Goals (v1)

- No Fleet-managed OAuth (`/login`) flow — users still run `pi` + `/login` in a terminal.
- No per-project (`.pi/settings.json`) overrides — global config only.
- No secret-vault integration for API keys beyond what pi already supports (env var / shell command references).
- No compaction / retry / message-delivery / shell settings — out of scope; users can hand-edit `settings.json` for those.
- No live file watcher — tab re-reads on open and window focus.

## Config Ownership

The tab reads and writes the user's **global** pi config:

- `~/.pi/agent/settings.json` — pi defaults, theme, enabledModels.
- `~/.pi/agent/models.json` — custom providers and per-model overrides.
- `~/.pi/agent/auth.json` — read-only; used to detect built-in provider auth status.

Writes use **merge-and-persist** semantics: re-read the file, merge the patch, write atomically. Any keys the UI doesn't know about survive byte-for-byte via Zod `passthrough()` schemas. This preserves hand-edited fields, new pi settings Fleet hasn't added UI for, and custom compat flags.

A per-file in-process async lock serializes writes so rapid UI saves can't interleave. Cross-process races with the user's CLI pi (e.g., pi is running and the user invokes `/settings` at the same instant) are accepted as rare: last writer wins, merge-on-write bounds the damage. The tab footer notes this.

## Navigation & Tab Layout

Add `'pi'` to the `SettingsSection` union in `src/renderer/src/components/settings/SettingsNav.tsx`, label `"Pi Agent"`, inserted after `Copilot` and before `Annotate`. Not darwin-only — pi runs everywhere Fleet does.

The tab renders a single scrollable pane with four stacked subsections:

1. **Defaults** — default provider, default model, thinking level, theme, model-cycling list.
2. **Built-in Providers** — read-only status cards (auth method, dot indicator).
3. **Custom Providers** — list + "Add Provider" button; each entry is a collapsible card.
4. **Footer** — "Open config folder" link + "Refresh" button + a one-line note about concurrent CLI edits.

## Data Model

All types live in `src/shared/pi-config-types.ts`. Zod schemas use `.passthrough()` end-to-end.

```ts
const PiSettingsSchema = z
  .object({
    defaultProvider: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultThinkingLevel: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
    theme: z.string().optional(),
    enabledModels: z.array(z.string()).optional()
  })
  .passthrough();

const PiApiKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string() }),
  z.object({ kind: z.literal('envVar'), name: z.string() }),
  z.object({ kind: z.literal('shell'), command: z.string() })
]);

const PiModelSchema = z
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

const PiProviderSchema = z
  .object({
    baseUrl: z.string().optional(),
    api: z
      .enum([
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai'
      ])
      .optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string()).optional(),
    authHeader: z.boolean().optional(),
    compat: z.record(z.unknown()).optional(),
    models: z.array(PiModelSchema).optional(),
    modelOverrides: z.record(PiModelSchema.partial()).optional()
  })
  .passthrough();

const PiModelsFileSchema = z
  .object({
    providers: z.record(PiProviderSchema).default({})
  })
  .passthrough();
```

`apiKey` is stored as pi's raw string (`"sk-..."`, `"MY_API_KEY"`, or `"!cmd ..."`). The renderer converts it to/from the discriminated `PiApiKey` view-model using these rules:

- Starts with `!` → `shell`
- Matches `^[A-Z][A-Z0-9_]*$` and no spaces → `envVar`
- Otherwise → `literal`

Users pick the kind explicitly in the UI, so the heuristic only applies on initial load.

## Preset Table

Hand-maintained list in `src/shared/pi-presets.ts`. Six entries:

| Preset id        | Label                  | Defaults filled in                                                                                                                 |
| ---------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `bedrock`        | Amazon Bedrock         | `api: anthropic-messages`; no `apiKey` field (AWS SDK credential chain); info block with `AWS_REGION` / `AWS_PROFILE` reminder     |
| `ollama`         | Ollama (local)         | `baseUrl: http://localhost:11434/v1`, `api: openai-completions`, `compat.supportsDeveloperRole: false`, `apiKey: "ollama"` literal |
| `lm-studio`      | LM Studio (local)      | `baseUrl: http://localhost:1234/v1`, `api: openai-completions`, `apiKey: "lmstudio"` literal                                       |
| `openrouter`     | OpenRouter             | `baseUrl: https://openrouter.ai/api/v1`, `api: openai-completions`, `apiKey: "OPENROUTER_API_KEY"` env-var                         |
| `vercel-gateway` | Vercel AI Gateway      | `baseUrl: https://ai-gateway.vercel.sh/v1`, `api: openai-completions`, `apiKey: "AI_GATEWAY_API_KEY"` env-var                      |
| `custom`         | Custom (OpenAI-compat) | no defaults — user fills everything                                                                                                |

Bedrock does not accept an `apiKey` in its preset form; pi's built-in Bedrock provider reads AWS credentials from env/SDK. Users adding Bedrock in the UI are really doing one of two things: adding custom Bedrock model IDs, or routing Bedrock through a proxy via `baseUrl`. The preset writes to `providers.bedrock.modelOverrides` for custom model entries so pi's built-in Bedrock models stay intact.

## IPC Surface

New module `src/main/pi-config-manager.ts`. Handlers registered in `src/main/ipc-handlers.ts`, exposed on the preload as `window.fleet.piConfig.*`. All methods async.

```ts
piConfig.readSettings(): Promise<PiSettings>
piConfig.writeSettings(patch: Partial<PiSettings>): Promise<void>

piConfig.readModels(): Promise<PiModelsFile>
piConfig.writeProvider(id: string, provider: PiProvider): Promise<void>
piConfig.deleteProvider(id: string): Promise<void>
piConfig.renameProvider(oldId: string, newId: string): Promise<void>

piConfig.getBuiltInStatus(): Promise<BuiltInProviderStatus[]>
piConfig.listAvailableModels(): Promise<ModelEntry[]>

piConfig.openConfigFolder(): Promise<void>
```

`BuiltInProviderStatus` shape:

```ts
type BuiltInProviderStatus = {
  id: string; // 'anthropic', 'openai', ...
  label: string; // display name
  authenticated: boolean;
  method: 'oauth' | 'env-var' | 'none';
  envVarName?: string; // when method === 'env-var' or 'none'
  hint?: string; // one-line setup hint
};
```

Built-in status is inferred by a read-only `src/main/pi-auth-inspector.ts` that reads `~/.pi/agent/auth.json` for OAuth tokens and checks known env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.) derived from pi's `env-api-keys.ts` catalog. No writes, no login flow.

`listAvailableModels` merges pi's built-in catalog (parsed from `@mariozechner/pi-ai`'s `models.generated.ts` in the installed pi dir) with custom providers' `models[]` entries. If the generated catalog can't be read, built-in models fall back to "ids only, no metadata" and the `defaultModel` picker becomes a free-text input.

## Read & Write Semantics

**Read path (every call):**

1. `readFile(path)`. If `ENOENT`, return schema default (e.g., `{ providers: {} }`).
2. `JSON.parse`. On failure, throw `PiConfigParseError { file, message, rawSnippet }`.
3. Zod `.parse` with passthrough. On failure, throw `PiConfigValidationError { file, issues }`.

**Write path (every call):**

1. Re-read the current file through the same pipeline (ensures we have the freshest state, including unknown fields).
2. Apply the patch:
   - `writeSettings(patch)`: shallow merge patch into the parsed object.
   - `writeProvider(id, provider)`: set `providers[id] = provider`, leaving siblings alone.
   - `deleteProvider(id)`: delete the key.
   - `renameProvider(old, new)`: insert the new key with the old value, delete the old key.
3. `JSON.stringify(obj, null, 2)` + trailing newline.
4. Atomic write: `writeFile(path + '.tmp')` then `rename(tmp, path)`. `mkdir -p` on parent as needed.
5. Per-file async lock (a `Map<string, Promise<void>>` chain) serializes concurrent writes.

## UI Component Layout

New files under `src/renderer/src/components/settings/pi/`:

```
pi/
  PiSection.tsx
  PiDefaultsForm.tsx
  PiBuiltInProvidersList.tsx
  PiCustomProvidersList.tsx
  PiProviderForm.tsx
  PiPresetPicker.tsx
  PiApiKeyInput.tsx
  PiModelsEditor.tsx
```

**`PiSection.tsx`** — loads settings + models + built-in status in parallel on mount; re-fetches on window focus. Renders a loading skeleton until the first load completes, then the four subsections.

**`PiDefaultsForm.tsx`** — `SettingRow` for each field:

- _Default provider_ — dropdown of built-ins + custom provider ids.
- _Default model_ — dropdown filtered to the selected provider's models (or free-text if the catalog isn't available).
- _Thinking level_ — dropdown (`off` | `minimal` | `low` | `medium` | `high` | `xhigh`).
- _Theme_ — text input (pi supports custom theme names).
- _Model cycling_ — textarea, newline-separated patterns.

Fields save on blur via `piConfig.writeSettings({ field: value })`.

**`PiBuiltInProvidersList.tsx`** — compact rows per provider: dot (green/red), label, method (`OAuth` | `ANTHROPIC_API_KEY` | `Not configured`), and a "?" tooltip with a setup hint. No interactive buttons — login still happens via CLI pi.

**`PiCustomProvidersList.tsx`** — "Add Provider" button (opens `PiPresetPicker`) and one collapsible card per provider:

- Collapsed: provider id, preset badge, model count, Edit / Delete.
- Expanded: inline `PiProviderForm`.

**`PiProviderForm.tsx`** — fields vary by preset:

- All: `id`, `baseUrl`, `api` dropdown, `PiApiKeyInput` (except Bedrock), optional headers rows, `compat` toggles (the three common flags as checkboxes plus an "Advanced JSON" textarea for the rest), nested `PiModelsEditor`.
- Bedrock: replaces `PiApiKeyInput` with an info block listing required AWS env vars.
- Save → `piConfig.writeProvider(id, provider)`. Delete → confirm modal → `piConfig.deleteProvider(id)`.

**`PiPresetPicker.tsx`** — modal with six cards; picking one closes the modal and appends a new provider card pre-filled with the preset's defaults, focused for editing.

**`PiApiKeyInput.tsx`** — segmented control `Env var | Literal | Shell cmd` + single input. "Literal" shows a warning badge: _"Stored in plain text in models.json"_. Serializes to pi's raw string form on save.

**`PiModelsEditor.tsx`** — row-per-model table: `id`, `name`, `contextWindow`, `maxTokens`, `reasoning` toggle, expandable "Advanced" block for `cost` and `input` types.

## Error Handling

| Scenario                                    | Behavior                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `~/.pi/agent/` missing                      | First write `mkdir -p`s it. Reads return schema defaults. No banner.                                                      |
| `settings.json` / `models.json` missing     | Reads return defaults; writes create the file.                                                                            |
| Malformed JSON                              | IPC throws `PiConfigParseError`. Subsection shows a red banner with "Open config folder"; form disabled.                  |
| Zod validation fails (shape violation)      | IPC throws `PiConfigValidationError`. Same banner, with the offending path. Fleet does not silently discard fields.       |
| External edit while tab open                | Not auto-detected. Manual "Refresh" icon and automatic re-read on window focus.                                           |
| Rapid in-Fleet saves                        | Per-file async lock serializes.                                                                                           |
| Concurrent writes with CLI pi               | Last writer wins; merge-on-write bounds the damage. Footer note advises users not to edit both sides at once.             |
| Duplicate provider id                       | Form validates against current providers; Save disabled with inline error.                                                |
| Delete built-in provider override           | Not exposed in v1. Existing `providers.anthropic.baseUrl`-style overrides are preserved via passthrough but not editable. |
| `apiKey` literal looks like an env-var name | User selected "Literal" explicitly; we write as-is. Warning badge communicates the tradeoff.                              |
| Bedrock without AWS env vars                | Not blocked. Pi errors at request time. Preset info block hints at required env vars.                                     |
| `auth.json` unreadable                      | Built-in status falls back to "Not configured" for all providers. No error banner.                                        |
| `models.generated.ts` unreadable            | Built-in model dropdown falls back to free-text input.                                                                    |
| Invalid JSON in "compat advanced" textarea  | Parse on blur, red underline + inline error until valid. Save disabled.                                                   |

## Files to Create & Modify

**New files:**

- `src/shared/pi-config-types.ts`
- `src/shared/pi-presets.ts`
- `src/main/pi-config-manager.ts`
- `src/main/pi-auth-inspector.ts`
- `src/renderer/src/components/settings/pi/PiSection.tsx`
- `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx`
- `src/renderer/src/components/settings/pi/PiBuiltInProvidersList.tsx`
- `src/renderer/src/components/settings/pi/PiCustomProvidersList.tsx`
- `src/renderer/src/components/settings/pi/PiProviderForm.tsx`
- `src/renderer/src/components/settings/pi/PiPresetPicker.tsx`
- `src/renderer/src/components/settings/pi/PiApiKeyInput.tsx`
- `src/renderer/src/components/settings/pi/PiModelsEditor.tsx`

**Modified files:**

- `src/shared/ipc-channels.ts` — add `piConfig:*` channel constants.
- `src/main/ipc-handlers.ts` — register `PiConfigManager` handlers.
- `src/main/index.ts` — instantiate `PiConfigManager`.
- `src/preload/index.ts` — expose `window.fleet.piConfig.*`.
- `src/preload/index.d.ts` — typed preload surface.
- `src/renderer/src/components/settings/SettingsNav.tsx` — add `'pi'` to the union, insert nav entry after Copilot.
- `src/renderer/src/components/settings/SettingsTab.tsx` — register `pi: PiSection` in the component map.

**Unchanged:** `settings-store.ts` (pi config is separate from `FleetSettings`), `pi-agent-manager.ts` (config management is its own module), existing pi extensions.

**Dependencies:** no new npm packages. Zod is already in the project. `shell.openPath` handles "Open config folder".
