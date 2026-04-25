# Pi agent extension broke on upgrade to @mariozechner/pi-coding-agent v0.68.x

## Symptom

`fleet pi` opened the tab but the terminal "flashed and closed" — pi process exited immediately. No visible error in the Fleet UI because `exitOnComplete: true` on the PiTerminal hides the output when pi exits.

## Root cause

`@mariozechner/pi-coding-agent` v0.68.0 (2026-04-20) removed the prebuilt cwd-bound tool-definition exports: `readTool`, `bashTool`, `editTool`, `writeTool`, `grepToolDefinition`, `findToolDefinition`, `lsToolDefinition`, etc. They were replaced by factory exports: `createGrepToolDefinition(cwd)`, `createFindToolDefinition(cwd)`, `createLsToolDefinition(cwd)`, etc.

`resources/pi-extensions/fleet-plan-mode.ts` imported the removed names. The imports resolved to `undefined`, so `pi.registerTool(undefined)` threw `Cannot read properties of undefined (reading 'name')`. pi aborted extension loading and exited → terminal closed instantly.

Reproduced directly:

```bash
echo "hi" | ~/.fleet/agents/pi/node_modules/.bin/pi -e resources/pi-extensions/fleet-plan-mode.ts --print
# Error: Failed to load extension "...fleet-plan-mode.ts": Cannot read properties of undefined (reading 'name')
```

## Fix

Switch to the factory exports, passing `process.cwd()` at extension init time (this matches the pattern in pi's own `examples/extensions/minimal-mode.ts`):

```ts
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
} from '@mariozechner/pi-coding-agent';

export default function (pi: ExtensionAPI): void {
  const cwd = process.cwd();
  pi.registerTool(createGrepToolDefinition(cwd));
  pi.registerTool(createFindToolDefinition(cwd));
  pi.registerTool(createLsToolDefinition(cwd));
  // ...
}
```

`process.cwd()` at extension load time is the project dir, because Fleet spawns pi via node-pty with the project cwd.

## Lesson

The Fleet PiTerminal uses `exitOnComplete: true`, which hides pi's stderr from the user when it crashes at startup. When debugging "flash and close" symptoms, reproduce by running the same command Fleet builds (`pi-agent-manager.ts: buildLaunchCommand`) directly in a shell — the error will be visible.

The `resources/pi-extensions/` files are not part of Fleet's TypeScript build (pi compiles them at runtime), so `npm run typecheck` will not catch breakages from pi-coding-agent major version bumps. Before bumping the pinned pi version, smoke-test each extension with `pi -e path/to/ext.ts --print`.

For policy-style extensions such as plan mode, prefer both layers:

- `pi.setActiveTools(...)` to hide unavailable tools from the model and rebuild the prompt for future turns.
- `pi.on('tool_call', ...)` blocking as the final enforcement point before execution, especially for stale or unexpected tool calls.

When a Pi extension asks for user approval before writing an artifact, include the target path and enough preview text in `ctx.ui.confirm(...)` for the user to make an informed decision. A prompt that only says "Write to path?" is not enough for plan approval.
