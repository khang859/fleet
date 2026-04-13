# Pi Plan Mode — Design

**Date:** 2026-04-13
**Status:** Approved — ready for implementation plan

## Goal

Add a "plan mode" to the Pi agent in Fleet, modelled on Claude Code's plan mode: while active, Pi can only use read-only tools, follows a structured investigation protocol, and produces a markdown plan as an artifact at the end. The user approves the plan before Pi exits plan mode and begins executing.

## Non-Goals

- **Multi-phase workflow** (brainstorm → spec → plan → execute). This spec covers a single research → plan → approve → execute cycle. A richer superpowers-style flow can come later if needed.
- **Fleet renderer UI** (a toggle button or indicator in the Pi tab chrome). Plan mode is entered and shown from within the Pi TUI only. The renderer can add affordances later.
- **Upstream changes to `@mariozechner/pi-coding-agent`**. Everything lives in Fleet's bundled Pi extensions.
- **Forced TDD or formatted plan templates.** The plan is free-form markdown. We set an investigation protocol, not an output template.

## Architecture

One new Pi extension bundled with Fleet:

- **File:** `resources/pi-extensions/fleet-plan-mode.ts`
- **Registration:** add to the extensions array in `src/main/pi-agent-manager.ts:83-85`, loaded alongside `fleet-bridge.ts`, `fleet-files.ts`, `fleet-terminal.ts`

The extension uses Pi's extension API (documented in `~/.fleet/agents/pi/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`) to:

1. Register a `/plan` slash command (enter plan mode).
2. On `before_agent_start`, inject a plan-mode system-prompt addendum while the mode is on.
3. On `tool_call`, block write/exec tools while the mode is on.
4. Register an `exit_plan_mode` tool that writes the plan to disk and asks the user to approve.
5. Show a footer status indicator via `ctx.ui.setStatus`.

State is held at module scope inside the extension: a single `planMode` boolean plus session-scoped bookkeeping (most recent plan path, so the LLM can reference it after exit). The state resets on `session_start` and clears on `session_shutdown`.

## Behavior

### Entering Plan Mode

User types `/plan` in the Pi TUI. Extension:

1. Sets `planMode = true`.
2. Calls `ctx.ui.setStatus("plan-mode", "📋 Plan Mode")` for the footer indicator.
3. Calls `ctx.ui.notify("Plan mode on — read-only until you approve the plan.", "info")`.

If `/plan` is run while already in plan mode, it's a no-op with a "plan mode already on" notify.

### System Prompt Addendum

While `planMode === true`, `before_agent_start` appends the following to the system prompt (returned via the event handler's `systemPrompt` field):

```
Plan Mode Investigation Protocol

You are in plan mode. Only read-only tools are available until you call exit_plan_mode. Follow this protocol:

1. Understand the question. Restate the ask in your own words if anything is ambiguous. Identify purpose, constraints, and what "done" looks like.

2. Explore before planning. Read the relevant files yourself — don't guess. Start broad (project structure, related docs, recent commits) then narrow to the specific code paths that will be touched. For bugs, find the root cause before proposing fixes.

3. Check scope. Is this one focused change or multiple independent pieces? If it spans several subsystems, say so and suggest breaking it up before planning.

4. Ask when ambiguous. If purpose, constraints, or success criteria are unclear, ask one question at a time. Prefer multiple-choice. Don't guess and move on.

5. Consider alternatives. Before committing, think through 2–3 options and their trade-offs. Recommend one and say why.

6. Follow existing patterns. Match conventions already in the codebase unless there's a specific reason to deviate. Don't propose unrelated refactoring.

7. YAGNI. Plan only what's asked. No speculative features, flags, or abstractions.

When you have enough that another engineer could execute without asking questions, call exit_plan_mode.
```

This addendum is stored as a `const` at the top of the extension file. It is appended to `event.systemPrompt` (not replaced), so it stacks with any other addenda from other extensions.

### Tool Blocking

While `planMode === true`, the `tool_call` handler blocks the following tools by returning `{ block: true, reason: "Plan mode is active — this tool is disabled. Use read-only tools to investigate, then call exit_plan_mode with your plan." }`:

- `write` — Pi built-in (write new file)
- `edit` — Pi built-in (modify file)
- `bash` — Pi built-in (all invocations — we do not attempt to classify commands as read-only vs. mutating)
- `fleet_run` — Fleet's terminal-execution extension (currently a stub; future-proofed)

Pi's read-only built-ins (`read`, `grep`, `find`, `ls`) and Fleet's `fleet_open` pass through unchanged. The `exit_plan_mode` tool (registered by this extension) is never blocked.

The `reason` string is returned to the LLM in the tool result, giving it feedback to self-correct.

### The `exit_plan_mode` Tool

Registered via `pi.registerTool()` with this schema:

| Parameter | Type   | Description                                                                                                          |
| --------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `plan`    | string | The implementation plan as markdown. Include a short title, brief context, and step-by-step actions with file paths. |
| `topic`   | string | Short kebab-case topic, e.g. `pi-plan-mode` or `fix-pty-leak`. Used in the filename.                                 |

Execution flow:

1. Validate `topic` is a non-empty kebab-case string (`/^[a-z0-9][a-z0-9-]*$/`). If invalid, return an error result so the LLM retries.
2. Compute the path: `<cwd>/docs/plans/YYYY-MM-DD-<topic>.md`, using the session's cwd. If the file already exists, append `-2`, `-3`, etc. until unique.
3. Ensure `docs/plans/` exists (mkdir recursive).
4. Show a confirmation via `ctx.ui.confirm`:
   - Title: `Approve plan?`
   - Body: the first ~60 lines of the plan plus the target path.
5. If approved:
   - Write the plan markdown to the path.
   - Set `planMode = false`.
   - Clear the footer status via `ctx.ui.setStatus("plan-mode", null)`.
   - Return `{ content: [{ type: "text", text: "Plan approved and written to <path>. Plan mode is off — you may now execute the plan." }] }`. The LLM sees the path in this result and can reference it in later turns.
6. If rejected:
   - Leave `planMode = true`.
   - Return `{ content: [{ type: "text", text: "User rejected the plan. Revise based on their feedback and call exit_plan_mode again when ready." }] }`.

The file is written only on approval, so rejected plans do not pollute `docs/plans/`.

### Cancelling Plan Mode

User can type `/plan cancel` to exit plan mode without producing a plan file. This flips `planMode = false` and clears the status. No artifact is written.

### Session Boundaries

On `session_start`, `planMode` is reset to `false` regardless of the previous session's state. On `session_shutdown`, the extension clears its state (nothing to persist to disk). Plan mode is intentionally per-session, not global.

## Files

- **Create:** `resources/pi-extensions/fleet-plan-mode.ts` — the extension (default-export function receiving `ExtensionAPI`).
- **Modify:** `src/main/pi-agent-manager.ts:83-85` — add `'fleet-plan-mode.ts'` to the `extensions` array.

No changes needed in `src/renderer/` for this iteration.

## Testing

Manual verification in a running Fleet + Pi session:

1. Start Pi, run `/plan`. Confirm footer shows "📋 Plan Mode" and notify appears.
2. Ask Pi to "add a logging helper". Confirm it reads files but refuses to write (the tool result should include the block reason).
3. Wait for Pi to call `exit_plan_mode`. Confirm the confirm dialog appears with the plan preview.
4. Approve. Confirm the file is written to `docs/plans/YYYY-MM-DD-<topic>.md`, footer clears, and Pi can now edit files.
5. Repeat 1–3 but reject the plan. Confirm no file is written and Pi remains in plan mode.
6. `/plan` then `/plan cancel`. Confirm mode exits with no file written.
7. Start a fresh session mid-plan-mode. Confirm the new session starts with `planMode = false`.

No automated tests for this iteration — the extension runs inside a subprocess and the approval dialog is interactive. If this becomes painful we can add a headless integration test later.

## Open Questions

None. All decisions are locked in per the brainstorming discussion:

- Path: `docs/plans/YYYY-MM-DD-<topic>.md`
- Blocked tools: `write`, `edit`, `bash`, `fleet_run`
- Entry/exit UX: `/plan` to enter, `exit_plan_mode` tool to exit via approval, `/plan cancel` to abort
- Prompt content: investigation protocol (not output template)
- TDD: not enforced
