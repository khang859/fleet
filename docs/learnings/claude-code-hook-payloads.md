# Claude Code hook payloads, as observed

Checked against Claude Code 2.1.285 on Linux while building session tracking (`src/main/claude-sessions/`).
Probes were `claude -p --settings <file>` with a hook that appended stdin to a file, and interactive runs in Fleet panes driven by `npm run drive`.

## What the hooks send

- Every hook event carries `transcript_path`, so Fleet takes the transcript location from the hook instead of rebuilding it.
- `SessionStart.source` was `startup` on launch and `clear` after `/clear`.
  The docs also list `resume`, `compact` and `fork`.
- `/clear` sends `SessionEnd` with `reason: "clear"` for the old session id, then `SessionStart` with `source: "clear"` and a new session id, from the same process in the same pane.
  This is why the registry ends the old session and bumps the pane's epoch when a new id shows up in a pane.
- A tool that fails sends `PostToolUseFailure`, not `PostToolUse`.
  A hook installer that only registers `PostToolUse` never hears that the tool finished, so a pending permission for it stays pending.
  Fleet registers both.
- `Stop` includes `last_assistant_message`, `UserPromptSubmit` includes `prompt` and `prompt_id`, and `SessionEnd` includes `reason`.

## What the hooks do not send

- `PermissionRequest` has no `tool_use_id`.
  Fleet matches it to the id from the `PreToolUse` just before it, and forgets queued ids at each turn boundary so a denied tool's id is never handed to a later, identical call.
- Answering a permission "No" or pressing Esc sends nothing at all: no `Stop`, no `PostToolUse`, and no idle `Notification`, even after minutes.
  Only the transcript records it, as a `tool_result` with `is_error: true`, `toolUseResult: "User rejected tool use"`, and then a user line `[Request interrupted by user for tool use]`.
- A `claude -p` that a tool runs inside a pane inherits `FLEET_PANE_ID` and sends its own `SessionStart`, `UserPromptSubmit` and `Stop` from a different pid, but no `SessionEnd`.
  Treating every new session id in a pane as `/clear` ended the pane's real session; the registry now takes over a pane only for the same pid, a `clear` or `resume` start, or a dead holder.

## Transcript shape

- The `toolUseResult` field on a tool result line is an object for a successful Bash call (`stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`) and a plain string for a failed one (`"Error: Exit code 2\n..."`).
  The matching `tool_result` block has `is_error: true` when it failed.
  Readers must accept both shapes.
- A `cost-state` line carries `totalCostUSD` and `modelUsage`.

## The project folder name

Claude Code names the folder under `projects/` by replacing every character that is not a letter or a digit with `-`.
`/tmp/probe dir_x.y` becomes `-tmp-probe-dir-x-y`.
Fleet used to replace only `/` and `.`, so any path with a space or an underscore pointed at a folder that does not exist.
`cwdToProjectDir` in `src/main/claude-sessions/transcript-path.ts` now matches Claude, and the transcript path from the hook is preferred anyway.

## The hook's parent is not always Claude

Claude Code runs a hook command through `sh -c`.
On macOS `/bin/sh` is bash, which execs a lone command in place, so the hook's parent pid is Claude.
On Debian and Ubuntu `/bin/sh` is dash, which forks, so the parent is a short-lived `sh` that exits as soon as the hook does.
Fleet checks that pid for liveness every 10 seconds, and on Linux it ended every session about 10 seconds after it started.
Unit tests could not catch it; it showed up only when running `claude` in a real pane.
The Go hook now steps past a parent whose command is a shell (`claudePID` in `hooks/fleet-copilot-go/main.go`).

## Typing into Claude Code

Writing a prompt and `\r` to the pty in one chunk does not submit it.
Claude Code treats a chunk that arrives all at once as a paste, and the `\r` inside it becomes a newline in the prompt.
Send the text, then send `\r` as its own write a moment later.
Anything that types a prompt for the user (the Orchestrator's `fleet_send`, drive scripts) must do the same.

## Still unverified

- Whether Claude Code versions older than the one that introduced `PostToolUseFailure` reject a `settings.json` that registers it.
  The installer registers it unconditionally.
