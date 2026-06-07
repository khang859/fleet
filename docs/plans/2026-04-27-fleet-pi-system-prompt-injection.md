# Fleet Pi System Prompt Injection Plan

## Context
Fleet launches Pi from `src/renderer/src/components/PiTab.tsx` by asking `window.fleet.pi.getLaunchConfig(paneId)` for a shell command. The main process builds that command in `src/main/pi-agent-manager.ts` and currently loads bundled Pi extensions with repeated `-e` flags:

- `resources/pi-extensions/fleet-bridge.ts`
- `resources/pi-extensions/fleet-files.ts`
- `resources/pi-extensions/fleet-terminal.ts`
- `resources/pi-extensions/fleet-plan-mode.ts`

Pi supports system-prompt injection in three relevant ways:

1. **Native prompt files / CLI flags**
   - `.pi/SYSTEM.md` or `~/.pi/agent/SYSTEM.md` replaces the default system prompt.
   - `.pi/APPEND_SYSTEM.md` or `~/.pi/agent/APPEND_SYSTEM.md` appends to the default prompt.
   - `--system-prompt <text-or-path>` replaces the default prompt.
   - `--append-system-prompt <text-or-path>` appends to the default prompt and can be repeated.
2. **Extension hook: `before_agent_start`**
   - Pi extensions can return `{ systemPrompt: ... }` from `pi.on('before_agent_start', ...)`.
   - Handlers are chained in extension load order; `event.systemPrompt` includes earlier handlers' changes.
   - Fleet already uses this in `resources/pi-extensions/fleet-plan-mode.ts` to append `PLAN_MODE_ADDENDUM` while `/plan` mode is active.
3. **Provider-payload hook: `before_provider_request`**
   - This can rewrite the final serialized provider payload, but it is mainly for debugging/provider-specific changes and is not reflected by `ctx.getSystemPrompt()`.

## Recommendation
Use a **bundled Fleet Pi extension** for Fleet-controlled injection, not user prompt files.

Reasons:

- Fleet already has the extension-loading pipeline in `PiAgentManager.getExtensionPaths()`.
- The extension hook appends cleanly to Pi's generated prompt instead of replacing it.
- It can be made conditional/dynamic later without changing Pi launch flags.
- It avoids writing to user/global Pi config files.
- It matches the existing `fleet-plan-mode.ts` pattern.

Use `--append-system-prompt` only for a simple static one-off prompt where changing `buildLaunchCommand()` is preferred over adding extension code. Avoid `.pi/APPEND_SYSTEM.md` for Fleet-owned behavior because it is project/user configuration, not app-owned configuration.

## Implementation Steps

### 1. Add a dedicated Fleet prompt extension
Create `resources/pi-extensions/fleet-system-prompt.ts`:

```ts
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

const FLEET_SYSTEM_PROMPT = `
<the Fleet-specific system prompt text goes here>
`.trim();

export default function (pi: ExtensionAPI): void {
  pi.on('before_agent_start', async (event) => {
    if (!FLEET_SYSTEM_PROMPT) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${FLEET_SYSTEM_PROMPT}`
    };
  });
}
```

Keep the prompt concise; if the goal is only to tell Pi about Fleet tools, prefer a short addendum over injecting all of `resources/skills/fleet.md` on every turn.

### 2. Register it in Fleet's Pi launch path
Modify `src/main/pi-agent-manager.ts` in `getExtensionPaths()`:

```ts
const extensions = [
  'fleet-bridge.ts',
  'fleet-files.ts',
  'fleet-terminal.ts',
  'fleet-system-prompt.ts',
  'fleet-plan-mode.ts'
];
```

Place it **before** `fleet-plan-mode.ts` so plan mode's addendum remains the last/highest-priority Fleet instruction when active.

### 3. Optional: make the prompt configurable later
If the prompt needs to come from Fleet settings rather than a constant:

- Add a setting in Fleet's settings store/UI.
- Pass it either via an env var in `PiAgentManager.buildLaunchCommand(...)` or write it to an app-owned file and pass the path.
- Have `fleet-system-prompt.ts` read that env var/file and append only when non-empty.

Do this only if needed; a static bundled prompt requires less code and fewer failure modes.

### 4. Verification
Because `resources/pi-extensions/*.ts` are loaded by Pi at runtime through jiti and are not covered by Fleet's `npm run typecheck`, verify both host and extension behavior:

1. Run host checks:
   ```bash
   npm run typecheck && npm run lint
   ```
2. Smoke-test the extension directly if possible:
   ```bash
   echo "hi" | ~/.fleet/agents/pi/node_modules/.bin/pi -e resources/pi-extensions/fleet-system-prompt.ts --print
   ```
3. Run Fleet, open a Pi tab, send a prompt that should reveal the injected behavior.
4. Optionally add a temporary status/debug extension or use `ctx.getSystemPrompt()` pattern from Pi's `examples/extensions/system-prompt-header.ts` to confirm prompt length/content during development.

## Key Files

- `resources/pi-extensions/fleet-plan-mode.ts` — existing working example of `before_agent_start` system prompt injection.
- `src/main/pi-agent-manager.ts` — bundled extension registration and Pi command construction.
- `src/renderer/src/components/PiTab.tsx` — renderer entrypoint that launches Pi using the generated command.
- `resources/skills/fleet.md` — existing Fleet command documentation; useful source material, but probably too large to inject wholesale every turn.

## Alternative Minimal Approach

For a static prompt without a new extension, modify `PiAgentManager.buildLaunchCommand()` to add:

```ts
parts.push('--append-system-prompt', posixShellQuote('/path/to/prompt.md'));
```

This makes the text part of Pi's base system prompt at startup. It is simpler for static text, but less flexible than an extension and mixes prompt policy into command construction.