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

The hook injects a lightweight pointer, not the full 233-line skill file.
The agent reads `~/.fleet/skills/fleet.md` on demand when it actually needs the CLI, keeping per-session context cost near zero.

### Pointer text

A constant template in `main.go`, with the skill-file path resolved to an absolute path at runtime via the binary's existing `homeDir()` helper (`main.go:30-35`) rather than a literal `~`.
Claude Code's Read tool expects absolute paths, and `~` is unreliable on Windows.
The old fallback prompt did the same (it built the path from `window.fleet.homeDir`).

> You're running inside Fleet.
> A `fleet` CLI is available (open files/images in Fleet tabs, annotate web pages, generate/edit AI images).
> Read `<home>/.fleet/skills/fleet.md` for the full command reference before using it.

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
- Add a helper with a testable signature, `emitSessionStartContext(w io.Writer, source string)`, that writes the JSON to `w` (the `SessionStart` case passes `os.Stdout`).
  Taking an `io.Writer` lets the test assert the output without invoking `main()` (see the test section).
  The pointer text lives as a constant template; the helper fills in the absolute skill-file path from `homeDir()`.

The stdout emission and the socket send are independent: stdout carries the injected context to Claude Code; the socket carries the pane-status event to Fleet.
The `SessionStart` case must not call `os.Exit` early, so it continues to the bottom `sendEvent`.

No change to `src/main/copilot/hook-installer.ts`: `SessionStart` is already registered.

### 2. Rebuild the hook binaries

Run `npm run build:hook` (`scripts/build-hook.sh`).
This rebuilds `hooks/bin/fleet-copilot-*` for all four targets (darwin/arm64, darwin/amd64, windows/amd64, linux/amd64).
Dev reads these from `hooks/bin/`; packaging bundles them to `resources/hooks/` and `hook-installer.ts` copies the matching binary into `~/.claude/hooks/` on launch.

`hooks/bin/` is gitignored and the binaries are not committed.
Only the Go source (`main.go`) is committed; CI rebuilds the binaries from source via `build:hook` during its build and release workflows.
Rebuild locally only so the dev app picks up the change.

### 3. `hooks/fleet-copilot-go/main_test.go`

The existing tests do not invoke `main()`; they test `sendEvent` and a simulated status-mapping switch (`TestStatusMapping`).
The new helper follows the same pattern: because `emitSessionStartContext(w io.Writer, source string)` takes a writer, the test passes a `bytes.Buffer` and asserts on its contents.

Add a test covering the new behavior:

- `source` = `startup` / `resume` / `clear` each write valid `additionalContext` JSON (correct `hookEventName`, non-empty `additionalContext` containing the absolute skill path) to the buffer.
- `source` = `compact` writes nothing to the buffer.
- Extend `TestStatusMapping` (or add a case) so the `SessionStart` status mapping stays covered; the socket-event path is already exercised in the existing simulated style.

### 4. Renderer removal (delete the manual path entirely)

- Delete `src/renderer/src/lib/fleet-skill-prompt.ts`.
- `src/renderer/src/components/PaneToolbar.tsx`: remove the "Inject Fleet Skills" button and the `onInjectSkills` prop, and the now-unused `BookOpen` lucide import.
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
- Injection re-fires on `/clear` and resume.
  Claude Code re-runs SessionStart hooks fresh on resume (it does not replay injected context from the transcript), so injecting on `resume` is necessary to keep the pointer present, not duplicative.

## Verification

- Go unit test: `go test ./hooks/fleet-copilot-go`.
- `npm run typecheck` and `npm run lint` (the lint pass catches orphaned imports from the renderer deletions).
- End-to-end via `npm run dev` plus `fleet-drive`:
  spawn a Claude Code pane, confirm the agent has the Fleet CLI context with no manual action, and confirm the toolbar button, keyboard shortcut, and palette entry are gone.
  Note: after `npm run build:hook`, the copy at `~/.claude/hooks/` only refreshes when `syncScript()` runs at app launch, so restart the dev app before E2E testing the hook change.
