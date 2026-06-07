# Pi Tool Recovery Extension Design

## Context

Fleet starts Pi with bundled extensions from `resources/pi-extensions` via `PiAgentManager.getExtensionPaths()`. Pi extensions can observe tool calls before execution with `tool_call` and can observe or modify completed tool results with `tool_result`.

The current problem is that Pi can attempt a tool name that does not exist in its available tool set, such as calling a `git` tool when only `bash` is available for Git commands. The failed tool call can make the agent stop instead of adapting and continuing.

## Goal

When a Pi tool call fails because the requested tool is unavailable or unsupported, Fleet should help the agent continue by returning clear retry guidance. For example, if Pi tries to call `git`, the result should tell it that no `git` tool exists and that Git commands should be run through `bash` instead.

## Non-Goals

- Do not automatically execute replacement commands.
- Do not synthesize a fake successful result.
- Do not clear the error flag on the failed tool call.
- Do not build a broad tool-aliasing framework.

## Approach

Add a new bundled Pi extension named `fleet-tool-recovery.ts`.

The extension registers a `tool_result` handler. When a result has `event.isError === true`, the handler checks whether the failed tool name is currently unavailable according to `pi.getActiveTools()`. If the failed name is not active, the extension returns a patched result whose text explains that the tool is unavailable and gives a concrete next step.

For the specific `git` tool name, the guidance should say to retry by using the `bash` tool with the intended `git ...` command. Other unavailable tools should receive generic guidance to inspect the active tools and retry with an available equivalent.

The extension should keep `isError` true. This preserves the semantic fact that the original tool call failed while giving the model enough information to recover on the next turn.

## Components

- `resources/pi-extensions/fleet-tool-recovery.ts`: Pi extension that registers the `tool_result` hook.
- `resources/pi-extensions/fleet-tool-recovery-policy.ts`: Small pure helpers for deciding whether a failed result needs retry guidance and for formatting the guidance text.
- `src/main/pi-agent-manager.ts`: Add `fleet-tool-recovery.ts` to the bundled extension list.
- `src/main/__tests__/fleet-tool-recovery-extension.test.ts`: Unit tests for the pure helper behavior.
- `src/main/__tests__/pi-agent-manager.test.ts`: Assert the new extension is included in launch commands.

## Error Handling

The extension should not throw for malformed result content. If content cannot be safely inspected, it should still append a simple text recovery message for unavailable tools.

Existing Pi behavior remains responsible for reporting the original failure to the model. Fleet only improves the wording of that failed result.

## Testing

Tests should verify:

- `git` unavailable-tool failures produce guidance that recommends `bash`.
- Other unavailable-tool failures produce generic retry guidance.
- Active/available tools do not receive recovery guidance.
- The Pi launch command includes `fleet-tool-recovery.ts` with the other bundled extensions.

## Acceptance Criteria

- Pi receives a failed tool result with guidance instead of only a dead-end unsupported-tool error.
- The `git` case explicitly points the agent to use `bash`.
- No automatic command execution is introduced.
- Existing plan-mode behavior remains unchanged.
