# Auto-inject Fleet skill into Claude Code via SessionStart hook

Date: 2026-07-03

## Problem

Fleet ships a `fleet` CLI that lets an AI agent drive the app (open files/images in tabs, annotate web pages, generate/edit AI images).
An agent only knows about it after the skill file `~/.fleet/skills/fleet.md` is loaded into its context.

Today loading is manual.
The pane toolbar has an "Inject Fleet Skills" button (also `Cmd/Ctrl+Shift+.` and a command-palette entry) that reads `~/.fleet/skills/fleet.md` and pastes it into the pane's PTY as a bracketed-paste block terminated with a carriage return.
The user must click it in every new Claude Code pane.

We want Claude Code running inside Fleet to learn about the CLI automatically, with no user action.

## Key insight

Fleet already owns Claude Code's startup injection point.
`src/main/copilot/hook-installer.ts` installs a native Go hook binary (`fleet-copilot-<platform>-<arch>`) into `~/.claude/hooks/` and registers it in `~/.claude/settings.json` for many events, including `SessionStart` (registered as a matcher-less `simpleHook()`).
Every PTY Fleet spawns gets `FLEET_SESSION=1` (`src/main/pty-manager.ts`), and the hook binary exits early when `FLEET_SESSION` is unset (`hooks/fleet-copilot-go/main.go`), so the hook only runs inside Fleet-spawned sessions.

Claude Code's `SessionStart` hook supports returning context to inject into the session via stdout JSON with `hookSpecificOutput.additionalContext`.
The binary already writes stdout JSON for the `PermissionRequest` case, so the stdout channel is proven to work.
We reuse it for `SessionStart`.

## Approach

Move injection from the renderer-side manual paste to the `SessionStart` hook, and delete the manual UI path.

The hook injects a lightweight pointer, not the full 234-line skill file.
The agent reads `~/.fleet/skills/fleet.md` on demand when it actually needs the CLI, keeping per-session context cost near zero.

### Pointer text

A hardcoded constant in `main.go`:

> You're running inside Fleet.
> A `fleet` CLI is available (open files/images in Fleet tabs, annotate web pages, generate/edit AI images).
> Read `~/.fleet/skills/fleet.md` for the full command reference before using it.

### Injection timing

`SessionStart` fires with a `source` field.
Inject on `startup`, `resume`, and `clear` (every time the agent's context is initialized or reset).
Skip `compact` (prior context is summarized, not wiped, so the pointer is still present).

## Data flow

```
Fleet spawns PTY (FLEET_SESSION=1) -> user runs `claude`
  -> Claude Code fires SessionStart hook (fleet-copilot binary)
      -> binary forwards the event to Fleet's unix socket (unchanged)
      -> if source in {startup, resume, clear}:
           print to stdout:
           {"hookSpecificOutput":{"hookEventName":"SessionStart",
            "additionalContext":"<pointer>"}}
      -> Claude Code injects the pointer into session context
  -> agent reads ~/.fleet/skills/fleet.md on demand when it needs the CLI
```

## Components changed

### 1. `hooks/fleet-copilot-go/main.go`

Additive change only.

- Add a `Source` field (`string`, json tag `source,omitempty`) to the `HookInput` struct.
- In the `SessionStart` case, keep the existing socket `sendEvent(state, false)` call at the bottom of `main` (event forwarding is unchanged).
  Additionally, when `Source` is `startup`, `resume`, or `clear`, print the `additionalContext` JSON to stdout.
  Do nothing extra when `Source` is `compact`.
- Add a small helper (for example `emitSessionStartContext()`) and the pointer text constant.

The stdout emission and the socket send are independent: stdout carries the injected context to Claude Code; the socket carries the pane-status event to Fleet.
The `SessionStart` case must not call `os.Exit` early, so it continues to the bottom `sendEvent`.

No change to `src/main/copilot/hook-installer.ts`: `SessionStart` is already registered.

### 2. Rebuild the hook binaries

Run `npm run build:hook` (`scripts/build-hook.sh`).
This rebuilds `hooks/bin/fleet-copilot-*` for all four targets (darwin/arm64, darwin/amd64, windows/amd64, linux/amd64).
Dev reads these from `hooks/bin/`; packaging bundles them to `resources/hooks/` and `hook-installer.ts` copies the matching binary into `~/.claude/hooks/` on launch.
The rebuilt binaries are committed.

### 3. `hooks/fleet-copilot-go/main_test.go`

Add a test covering the new behavior:

- `source` = `startup` / `resume` / `clear` produce valid `additionalContext` JSON on stdout.
- `source` = `compact` produces no `additionalContext` on stdout.
- Existing behavior: the `SessionStart` socket event still fires.

### 4. Renderer removal (delete the manual path entirely)

- Delete `src/renderer/src/lib/fleet-skill-prompt.ts`.
- `src/renderer/src/components/PaneToolbar.tsx`: remove the "Inject Fleet Skills" button and the `onInjectSkills` prop.
- `src/renderer/src/components/TerminalPane.tsx`: remove the `onInjectSkills` wiring and the now-unused import.
- `src/renderer/src/components/PiTab.tsx`: remove the `onInjectSkills` wiring and the now-unused import.
- `src/renderer/src/lib/commands.ts`: remove the `inject-skills` command-palette entry.
- `src/renderer/src/lib/shortcuts.ts`: remove the `inject-skills` keybinding (`Cmd/Ctrl+Shift+.`).
- `src/renderer/src/hooks/use-pane-navigation.ts`: remove the `inject-skills` keydown handler and the now-unused import.

## Untouched

- `installSkillFile()` (`src/main/install-fleet-cli.ts`) stays.
  The pointer references `~/.fleet/skills/fleet.md`, so that file must still be installed on every launch.
- `resources/skills/fleet.md` (the skill source of truth) is unchanged.
- The `opencode` plugin installer (`installOpencodePlugin()`) is a separate path and keeps working.

## Scope and tradeoffs

- Claude Code only.
  Non-Claude agents (plain shells, Codex) lose the manual button and get no auto-inject.
  This is accepted: Claude Code is the primary target, and opencode is covered by its own plugin path.
- PiTab is slated for removal anyway, so cleaning up its wiring now is harmless.
- Per-session context cost stays near zero (a one-line pointer, not the full file).
- Injection re-fires on `/clear` and resume, so the pointer survives context resets within a long-running pane.

## Verification

- Go unit test: `go test ./hooks/fleet-copilot-go`.
- `npm run typecheck` and `npm run lint` (the lint pass catches orphaned imports from the renderer deletions).
- End-to-end via `npm run dev` plus `fleet-drive`:
  spawn a Claude Code pane, confirm the agent has the Fleet CLI context with no manual action, and confirm the toolbar button, keyboard shortcut, and palette entry are gone.
