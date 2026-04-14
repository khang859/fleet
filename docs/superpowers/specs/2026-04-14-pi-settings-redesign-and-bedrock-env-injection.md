# Pi Agent Settings Redesign + Bedrock Env-Var Injection

Reshape Fleet's Pi Agent settings page so first-time users have clear direction, and give Amazon Bedrock a first-class configuration surface that injects AWS env vars into every Pi tab Fleet spawns.

This spec builds on and partially supersedes `2026-04-13-pi-agent-settings-tab-design.md`. The IPC surface, storage files, and data model introduced there stay as-is. The changes here replace the page's internal structure and add a new env-injection subsystem.

## Problem

The current Pi Agent settings page is a single long scroll with four stacked sections (Defaults → Built-in Providers → Custom Providers → Footer). User feedback: "daunting, lots of settings, no directions at all."

Specific friction points:

- **No onboarding.** A first-time user landing on the page sees "Defaults" first — but they can't set defaults until a provider is configured. Order is backwards.
- **Bedrock is awkwardly split.** Status appears in the read-only Built-in Providers list; credential-style configuration lives in the Custom Providers preset picker. Two different surfaces for one provider.
- **Bedrock credentials are not actually configurable from the UI.** The preset's form has `skipApiKey: true` and only shows a hint telling users to set `AWS_REGION` / `AWS_PROFILE` in their shell. Users expect to type these in Fleet and have them apply to the Pi tab Fleet opens.
- **Wall of controls.** Defaults mixes everyday settings (provider, model, thinking level) with rarely-changed ones (theme, model cycling). 13 built-in provider rows sit between the user and the custom-provider action they likely came for.

## Goals

1. A Pi Agent page that a user who has never seen pi before can parse and act on within a few seconds.
2. Bedrock configurable end-to-end from the UI: `AWS_PROFILE`, `AWS_REGION`, and (optionally) `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` stored in Fleet and injected into Pi PTY spawns.
3. Secrets stored through Electron `safeStorage` (OS keychain), never written to pi's `~/.pi/agent/` files, never logged, never crossing the IPC boundary to the renderer.
4. Zero disruption to the user's CLI pi. We do not touch their shell environment; Fleet's injection is scoped to Pi tabs Fleet launches.

## Non-Goals (v1)

- No env-var injection for providers other than Bedrock. Azure / Mistral / Groq / Vertex / HuggingFace / xAI stay in the read-only "set your shell env var" mode. The storage format and main-process manager are designed to extend without migrations, but the UI surface is Bedrock-only in v1.
- No Fleet-managed OAuth flow. `/login` for Anthropic / OpenAI / Google / Copilot still happens in a terminal pi.
- No per-tab or per-workspace overrides. Env-var injection is global across all Pi tabs Fleet opens.
- No live file watcher on `~/.pi/agent/` (unchanged from the prior spec).

## UX Principles Applied

- **Chunking** (NN/g) — section boundaries enforced with whitespace and single-sentence headers; no more compressed multi-section scroll.
- **Progressive disclosure** (NN/g/Nielsen) — rarely-changed settings (theme, model cycling, CLI concurrency note, config folder link) move into a collapsed `Advanced ▾` accordion. Secondary providers (Azure, Vertex, Mistral, Groq, Cerebras, xAI, HuggingFace, Copilot) live behind a `Show more providers ▸` toggle.
- **Describe the goal** (NN/g "4 Principles to Reduce Cognitive Load in Forms") — each subsection gets a single-sentence intro line.
- **Empty-state direction** (Baymard) — when no provider is configured, a welcome strip at the top prompts the user with three concrete next steps (Anthropic / Bedrock / Ollama). It self-removes once any provider is configured.

## Page Structure

Four stacked regions under the `Pi Agent` heading:

```
Pi Agent
Configure which models pi can use. Pi shares this config with your CLI.

[Welcome strip — only when 0 providers configured]
  "Pick how you want to run pi:"
  [Anthropic]  [Amazon Bedrock]  [Ollama (local)]
  ... more providers ▸

Providers                                   [+ Add custom]
  ● Anthropic          OAuth                         ▸ Expand
  ○ Bedrock            Needs AWS region + creds      ▸ Expand
  ● OpenAI             OPENAI_API_KEY set            ▸ Expand
  ○ Google Gemini      GOOGLE_API_KEY…               ▸ Expand
  ○ Ollama             Set up Ollama locally         ▸ Expand
  ○ OpenRouter         Set OPENROUTER_API_KEY        ▸ Expand
  ● openrouter-proxy (c.)  3 models                  ▸ Expand
  ▸ Show 7 more providers (Azure, Vertex, Mistral, …)

Defaults
  Used when you open a new Pi tab without specifying otherwise.
  Default provider  |  Default model  |  Thinking level

▸ Advanced
  Theme · Model cycling · Open config folder · CLI concurrency note
```

**Welcome strip visibility rule.** Shown when `configuredProviderCount === 0`. "Configured" = any built-in with `authenticated: true` OR any custom provider present in `models.json`. Clicking a card scrolls to that provider's row and auto-expands it.

**Section intros.** One-line descriptions under each `h2`:

- Providers: _"Each provider needs credentials or an auth method. Click a row to configure."_
- Defaults: _"Used when you open a new Pi tab without specifying otherwise."_
- Advanced: _"Rarely-changed settings and tools."_

## Unified Providers List

The current `PiBuiltInProvidersList` (read-only status rows) and `PiCustomProvidersList` (editable custom providers) collapse into one `PiProvidersList` component rendering `PiProviderRow` entries.

### Row (collapsed) anatomy

```
[dot] [provider label]  [status text]                          [▸]
```

- **Dot color:** green = authenticated / configured, amber = partially configured (Bedrock with region but no creds, or a custom provider missing `apiKey`), grey = not configured.
- **Label:** provider display name (`Anthropic`, `Amazon Bedrock`, `Ollama`, …). Custom providers append a small ` (c.)` badge.
- **Status text:** one short phrase — `OAuth`, `OPENAI_API_KEY set`, `Needs AWS region + creds`, `3 models`, etc.
- **Expand affordance:** right-aligned chevron.

### Row ordering

Top to bottom:

1. **Configured providers** (dot is green), alphabetical by label. Any built-in with detected auth or any custom provider present in `models.json` qualifies — custom providers mix into this tier rather than forming a separate group.
2. **Unconfigured primary built-ins** (dot is grey/amber): Anthropic, Bedrock, OpenAI, Google, Ollama, OpenRouter. Alphabetical within the tier.
3. **`Show more providers ▸`** — collapsed by default. Reveals the secondary built-ins: Azure, Vertex, Mistral, Groq, Cerebras, xAI, HuggingFace, Copilot.

Ordering is computed once per `PiSection` load and on window-focus refresh; it does not re-shuffle mid-session as a provider's auth state changes.

### Row (expanded) — dispatched by provider kind

| Provider kind                                                                                                | Expanded content                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| OAuth-capable built-in (Anthropic, OpenAI, Google, Copilot)                                                  | Current auth state (OAuth token present / not); callout `Run pi and /login in a terminal to authenticate` with a copy-command button. Read-only. |
| Env-var built-in with managed injection (v1: **Bedrock only**)                                               | `PiBedrockPanel` — see next section.                                                                                                             |
| Other env-var built-ins (Azure, Vertex, Mistral, Groq, Cerebras, xAI, HuggingFace, OpenRouter built-in tier) | Status row for the expected env var + "Set `X` in your shell" hint. No editable fields in v1.                                                    |
| Custom provider                                                                                              | Existing `PiProviderForm` (id, baseUrl, api, `PiApiKeyInput`, compat JSON, `PiModelsEditor`). No internal changes.                               |

### Add flow

`[+ Add custom provider]` button opens the existing `PiPresetPicker`. **The Bedrock preset card is removed from the picker** — Bedrock is now a first-class row in the unified list; adding a second custom-provider Bedrock entry would be confusing. The other presets (Ollama, LM Studio, OpenRouter, Vercel Gateway, Custom) remain.

## Bedrock Detail Panel — `PiBedrockPanel`

Expanded Bedrock row content:

```
Amazon Bedrock
Status:  ○ Needs region + credentials

AWS Region            [us-east-1                        ]

Credentials
  ◉ Use AWS profile (recommended)
  ○ Use access keys
  ○ Use credential chain (current behavior)

[Profile: default                                       ]   ← "profile" mode

[Access Key ID                                          ]   ← "keys" mode
[Secret Access Key                                      ]   🔒 encrypted (OS keychain)
[Session Token — optional (STS)                         ]   🔒 encrypted (OS keychain)

These values are injected into Pi tabs Fleet opens.
They do NOT affect the `pi` CLI you run in a terminal.

Models                                        [+ Add model]
  anthropic.claude-sonnet-4-5-20250929-v1:0           [Edit]
  us.anthropic.claude-opus-4-20250514-v1:0            [Edit]
```

### Credential modes

| Mode                | Env vars written on spawn                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `profile` (default) | `AWS_PROFILE`, `AWS_REGION` (if set)                                                                       |
| `keys`              | `AWS_REGION` (if set), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` (if set)          |
| `chain`             | `AWS_REGION` (if set), nothing else — inherits everything from the parent shell (matches today's behavior) |

Only fields relevant to the active mode are shown.

### Secret field behavior

- Secret Access Key and Session Token are **write-only** in the UI: after a write, the field shows `●●●●●●●● (set)` with a `[Clear]` button. Retrieving the plaintext back into the renderer is never supported.
- A user who wants to rotate the secret re-enters it in the same field.
- Secret values never cross the IPC boundary to the renderer. The main process decrypts at PTY spawn time only.

### Models list

Writes to `providers.bedrock.modelOverrides` in `~/.pi/agent/models.json` via the existing `piConfig.writeProvider` IPC. Matches the prior spec's behavior — pi's built-in Bedrock catalog remains authoritative, and user-added custom model ids stack on top.

## AWS Env-Var Storage Model

New module `src/main/pi-env-injection-manager.ts`.

### File layout

Stored under a new `piEnvInjection` key in Fleet's existing settings store (`settings-store.ts`). Schema:

```ts
const PiBedrockInjectionSchema = z.object({
  mode: z.enum(['profile', 'keys', 'chain']).default('chain'),
  region: z.string().optional(),
  profile: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKeyEnc: z.string().optional(), // base64 of safeStorage.encryptString output
  sessionTokenEnc: z.string().optional() // base64 of safeStorage.encryptString output
});

const PiEnvInjectionSchema = z
  .object({
    bedrock: PiBedrockInjectionSchema.optional()
  })
  .passthrough();
```

`passthrough()` lets us add more providers (`azure`, `mistral`, …) later without migrating the file.

### Manager surfaces

```ts
class PiEnvInjectionManager {
  // Main-process only; returns decrypted values ready to inline into a launch command.
  // Skips any field whose decryption fails.
  getInjectedEnv(): Record<string, string>;

  // IPC-safe. Secrets are represented as { present: boolean }, never plaintext.
  getRedactedConfig(): { bedrock?: RedactedBedrock };

  writeBedrock(patch: Partial<BedrockWritePatch>): void; // accepts plaintext secret; encrypts inside
  clearBedrockSecret(field: 'secretAccessKey' | 'sessionToken'): void;
}
```

### safeStorage availability

If `safeStorage.isEncryptionAvailable()` returns false (rare — headless Linux without a keyring is the common case):

- `writeBedrock` with a secret throws; UI surfaces a banner in `PiBedrockPanel`.
- "Use access keys" mode is hidden from the credential-mode picker.
- Users are offered the existing shell-command reference pattern (pi's `!cmd` apiKey syntax) as an escape hatch — documented in the panel's hint, no new code.

### Secrets never cross IPC

- Renderer → main: plaintext secrets are sent only via the explicit `piEnv.writeBedrock` channel, synchronous round trip to the main process where `safeStorage.encryptString` runs immediately. The plaintext is not retained.
- Main → renderer: only `getRedactedConfig()` is exposed. Secrets are represented as `{ present: true }` flags.
- Decryption happens only in the main process at PTY spawn time.

## Env-Var Injection Into Pi Tab Launches

`PiAgentManager.buildLaunchCommand` (currently `src/main/pi-agent-manager.ts:92`) grows an `envOverrides` parameter:

```ts
buildLaunchCommand(
  bridgePort: number,
  bridgeToken: string,
  paneId: string,
  envOverrides: Record<string, string>
): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(envOverrides)) {
    parts.push(`${k}=${posixShellQuote(v)}`);
  }
  parts.push(`FLEET_BRIDGE_PORT=${bridgePort}`);
  parts.push(`FLEET_BRIDGE_TOKEN=${bridgeToken}`);
  parts.push(`FLEET_PANE_ID=${paneId}`);
  parts.push(this.quoteArg(this.getBinPath()));
  for (const ext of this.getExtensionPaths()) {
    parts.push('-e', this.quoteArg(ext));
  }
  return parts.join(' ');
}
```

`posixShellQuote` is a new small helper in the same file: wraps the value in single quotes and escapes internal single-quote characters via the standard `'\''` sequence. This prevents a secret containing `$`, spaces, backticks, or quotes from breaking the command line.

### IPC handler wiring

`IPC_CHANNELS.PI_LAUNCH_CONFIG` in `src/main/ipc-handlers.ts:499`:

```ts
ipcMain.handle(IPC_CHANNELS.PI_LAUNCH_CONFIG, async (_event, req: { paneId: string }) => {
  await piAgentManager.ensureInstalled();
  const token = fleetBridge.generateToken();
  const port = fleetBridge.getPort();
  const env = piEnvInjectionManager.getInjectedEnv(); // decrypts here, main-only
  const cmd = piAgentManager.buildLaunchCommand(port, token, req.paneId, env);
  return { cmd };
});
```

When `envOverrides` is empty, the output command is byte-identical to today's.

### Variable precedence

Inline shell-variable assignments (`FOO=bar /path/to/bin`) set variables only for the exec'd process. If the user's shell already exports `AWS_REGION=...`, our inlined value wins for the pi child process. This is the desired behavior — Fleet's UI is the source of truth for Pi tabs Fleet opens.

## New IPC Channels

```
PI_ENV_READ_BEDROCK       — renderer → main: returns RedactedBedrock | undefined
PI_ENV_WRITE_BEDROCK      — renderer → main: writes patch, encrypts secrets on arrival
PI_ENV_CLEAR_SECRET       — renderer → main: clears secretAccessKeyEnc or sessionTokenEnc
PI_ENV_IS_ENCRYPTION_AVAILABLE — renderer → main: passthrough of safeStorage check
```

Exposed on preload as `window.fleet.piEnv.*`.

## Defaults & Advanced Sections

### Defaults (trimmed)

Three fields only:

- **Default provider** — dropdown; source is the unified Providers list (configured entries first, then primary built-ins, then custom).
- **Default model** — dropdown filtered by selected provider; free-text fallback when `models.generated.ts` isn't readable (same fallback logic as today).
- **Thinking level** — enum dropdown: `off | minimal | low | medium | high | xhigh`.

Fields save on change via the existing `piConfig.writeSettings` IPC. No visual changes to `SettingRow` or form primitives.

### Advanced (collapsed `▾` accordion, new `PiAdvancedAccordion`)

Holds everything de-prioritized from the main flow:

- **Theme** — free-text input (pi supports custom theme names).
- **Model cycling** — textarea, one pattern per line (Ctrl+P list).
- **Config folder** — `~/.pi/agent/` path + `[Open]` button (wraps existing `piConfig.openConfigFolder`).
- **CLI concurrency note** — the one-line note currently in the footer.

The accordion starts collapsed. Opening state is not persisted — it's fine for it to reset across tab switches.

## Migration

A user who added a Bedrock entry under the old "custom provider" preset has `providers.bedrock` in their `~/.pi/agent/models.json`. On first render of the new page with such an entry present, the Bedrock row shows an inline migration banner:

```
We now configure Bedrock centrally. Move your custom model entries
into the new Bedrock panel?
[Move]  [Keep as custom provider]
```

- **Move:** copy `providers.bedrock.modelOverrides` (and `.models`) into the new panel's model list (which writes back to `providers.bedrock.modelOverrides` — functionally no-op) and delete any baseUrl / api / apiKey fields that were added. Preserve passthrough fields.
- **Keep as custom:** Bedrock continues rendering via the custom-provider path, appearing as a row in the Providers list labeled `bedrock (c.)`.

No silent rewrites.

## Files to Create & Modify

### New files

- `src/shared/pi-env-injection-types.ts` — Zod schemas + TypeScript types for `PiBedrockInjection` and `RedactedBedrock`.
- `src/main/pi-env-injection-manager.ts` — storage, encryption, redaction, `getInjectedEnv`.
- `src/main/__tests__/pi-env-injection-manager.test.ts`.
- `src/renderer/src/components/settings/pi/PiProvidersList.tsx` — unified list.
- `src/renderer/src/components/settings/pi/PiProviderRow.tsx` — row chrome + expansion dispatch.
- `src/renderer/src/components/settings/pi/PiBedrockPanel.tsx` — Bedrock credential + region form.
- `src/renderer/src/components/settings/pi/PiWelcomeStrip.tsx` — zero-state onboarding cards.
- `src/renderer/src/components/settings/pi/PiAdvancedAccordion.tsx` — collapsed advanced region.
- `src/renderer/src/components/settings/pi/__tests__/PiProvidersList.test.tsx`.
- `src/renderer/src/components/settings/pi/__tests__/PiBedrockPanel.test.tsx`.

### Modified files

- `src/main/pi-agent-manager.ts` — `buildLaunchCommand` takes `envOverrides`; `posixShellQuote` helper added.
- `src/main/__tests__/pi-agent-manager.test.ts` — extend with envOverrides round-trip + POSIX quoting tests.
- `src/main/ipc-handlers.ts` — wire `PI_ENV_*` handlers; pass `getInjectedEnv()` into `PI_LAUNCH_CONFIG`.
- `src/main/index.ts` — instantiate `PiEnvInjectionManager`.
- `src/preload/index.ts` + `src/preload/index.d.ts` — expose `window.fleet.piEnv.*`.
- `src/shared/ipc-channels.ts` — new `PI_ENV_*` channel constants.
- `src/shared/pi-presets.ts` — remove `'bedrock'` from `PI_PRESETS`; add `managedEnv: true` flag on the Bedrock entry in `PI_BUILT_IN_PROVIDERS`.
- `src/renderer/src/components/settings/pi/PiSection.tsx` — replace the current four stacked children with `PiWelcomeStrip` → `PiProvidersList` → `PiDefaultsForm` → `PiAdvancedAccordion`. Drop the current footer (its contents move into `PiAdvancedAccordion`).
- `src/renderer/src/components/settings/pi/PiDefaultsForm.tsx` — drop theme and model-cycling fields (moved to Advanced); no API changes.
- `src/renderer/src/components/settings/pi/PiPresetPicker.tsx` — hide the Bedrock preset card (filter on render; preset still exists in code in case migration logic needs it).

### Unchanged

- `src/main/pi-config-manager.ts`, `src/main/pi-auth-inspector.ts`.
- `src/shared/pi-config-types.ts` (schemas for `settings.json` / `models.json` are unchanged).
- `PiProviderForm`, `PiApiKeyInput`, `PiModelsEditor` — reused from custom-provider path.

## Error Handling

| Scenario                                                                                      | Behavior                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safeStorage.isEncryptionAvailable()` returns false                                           | "Use access keys" mode hidden from picker; inline banner in `PiBedrockPanel`; shell-command reference pattern suggested.                                    |
| Decryption fails at launch time (keychain wiped, different macOS user, corrupted ciphertext)  | Skip the unreadable var; launch proceeds with what we can decrypt. Next open of `PiBedrockPanel` shows red banner: _"Stored secret unreadable — re-enter."_ |
| User's shell exports `AWS_REGION=...` already                                                 | Inline-assigned value wins for the pi child process. Tooltip on Region field: _"Overrides any value in your shell for Fleet's Pi tabs."_                    |
| Region left blank in `keys` mode                                                              | Non-blocking warning row: _"Without AWS_REGION, Bedrock defaults to us-east-1."_ No error.                                                                  |
| POSIX-quoting edge cases (value with `$`, spaces, quotes, backticks)                          | Handled by `posixShellQuote`; covered by unit tests.                                                                                                        |
| Welcome strip visibility                                                                      | Pure function of `configuredProviderCount`; unit-tested.                                                                                                    |
| Legacy `providers.bedrock` in `models.json`                                                   | Inline migration banner (see Migration section). No silent rewrite.                                                                                         |
| `PiBedrockPanel` open while migration banner present + user opens Bedrock preset via old path | Not reachable — preset card is hidden from `PiPresetPicker`.                                                                                                |

## Testing

- **`pi-env-injection-manager.test.ts`** — encrypt/decrypt round-trip; fallback when `safeStorage` unavailable; passthrough preservation (unknown sibling keys survive writes); redaction correctness (no plaintext in `getRedactedConfig` output); `clearBedrockSecret` removes the ciphertext cleanly.
- **`pi-agent-manager.test.ts`** (extend) — `buildLaunchCommand` with `envOverrides`: empty map produces today's output byte-for-byte; values containing single-quotes, `$`, spaces, newlines, and backticks are correctly quoted; launch string remains parseable by `/bin/sh`.
- **`PiProvidersList.test.tsx`** — list composition (configured first, secondary-tier behind "Show more", custom badge rendering); welcome strip visibility keyed on configured count; row expansion dispatches to the correct panel component per provider kind.
- **`PiBedrockPanel.test.tsx`** — credential-mode switching shows/hides the right fields; secret field renders as `●●●●●●●● (set)` after a write; `Clear` calls the right IPC; migration banner appears when legacy `providers.bedrock` is present; decryption-failure red banner surfaces the right message.

No new npm dependencies. `safeStorage` is built into Electron. Zod, React Testing Library, Vitest, and the existing IPC test harness cover everything above.

## Relationship to the 2026-04-13 Spec

This spec replaces these sections of `2026-04-13-pi-agent-settings-tab-design.md`:

- **Navigation & Tab Layout** (§5) — four-region layout replaces "four subsections in a single scrollable pane."
- **Preset Table** (§8) — Bedrock preset removed from the custom-provider picker; its defaults are no longer user-facing.
- **UI Component Layout** (§10) — file list above supersedes the old one; `PiBuiltInProvidersList` is deleted.

The following sections from the prior spec are unchanged and remain authoritative:

- **Config Ownership** — pi's `~/.pi/agent/` files (`settings.json`, `models.json`, `auth.json`), merge-and-persist semantics, per-file async lock, Zod passthrough.
- **Data Model** (§7) — `PiSettingsSchema`, `PiModelsFileSchema`, `PiProviderSchema`.
- **IPC Surface** (§9) — `piConfig.*` channels stay identical. `piEnv.*` channels are additive.
- **Read & Write Semantics** (§11) — unchanged.
