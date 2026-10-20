# Learnings: the fleet-bridge Claude Code mod (2026-10-20)

Fleet sends prompts to Claude Code through a mod (`resources/claude-mod/fleet-bridge`) and `src/main/claude-sessions/prompt-bridge.ts`, with typing into the terminal kept as the fallback.
These are the surprises found while building it on Claude Code 2.1.304.

## A held request keeps `claude -p` from exiting

The mod long-polls Fleet with `$.http.fetch`.
Started from `session.start` in a `-p` run, the open request held the process for the whole hold time: `claude -p "say hi"` took 21 s instead of 2 s.
**Fix:** poll only when `session.start`'s `e.isInteractive` is true.
An interactive `/exit` is not held: the process ends in under a second.

## Claude Code writes into a mod's folder

A mod loaded from `CLAUDE_CODE_PLUGIN_DIRS` gets `.claude-plugin/types/` and a `tsconfig.json` written into its folder.
So the mod cannot be loaded from the signed, read-only app bundle.
**Fix:** `installClaudeMod` copies it to `~/.fleet/claude-mods[-dev]/fleet-bridge` before the window opens, writing only files that changed.

## `/clear` changes the session id with no `session.start`

After `/clear` the process goes on under a new id, and the mod's open request still names the old one for up to the hold time.
Prompts sent then fell back to typing.
**Fix:** on `session.end` with reason `clear` or `resume`, start a new poll loop and stop the old one by a generation counter.
The new loop skips only the id that just ended: `/resume` back to an earlier session runs under that session's old id again, so an id that ended once is not stale for good.

## Two mods asking for one session

A Fleet started from another Fleet's pane inherits that one's `CLAUDE_CODE_PLUGIN_DIRS`, so two copies of the mod would poll for each session and replace each other's request in a busy loop.
**Fix:** `claudeModEnv` drops any inherited Fleet mod folder, and a replaced request is answered 409, which makes the mod wait 5 s before asking again.

## `claude plugin validate` follows `$`

The validator refuses a module that passes `$` to a function that is not declared at the top of the file (a closure inside `register` does not count).
Keep helpers that take `$` as top-level functions.

## What the model sees

`$.prompt.submit({ text, asUser: true })` reaches the model as the person's own words, not as `<pasted_content>`, however long.
The classic `UserPromptSubmit` hook still fires with the exact text, so Fleet's prompt-hash acknowledgement works unchanged.
The transcript line carries `origin: { kind: 'plugin', name: 'fleet-bridge', asUser: true }`.

## Answering permissions from the mod

The mod's `classic.PermissionRequest` hook asks Fleet over `POST /permission` (`src/main/claude-sessions/permission-bridge.ts`).
These held on Claude Code 2.1.304:

- The hook runs while the terminal's dialog is already open, not before it.
  An allow it returns late still closes the dialog, which shows "Allowed by PermissionRequest hook".
- An answer in the terminal aborts `next.signal`, and with it the hook's open `$.http.fetch`.
  Fleet sees the ask close and drops the card at once.
  The hook must return `{}` then, not call `next(e)`, or the Go hook would ask Fleet a second time.
- Returning without `next(e)` skips every settings hook, the person's own `PermissionRequest` hooks too, not just Fleet's Go hook.
  A first version returned `{}` on a 409 as well, so in a Fleet pane with no answerer the person's own hooks stopped running.
  **Fix:** on a 409 the mod calls `next(e)`. Fleet's Go hook then tells Fleet of the request a second time, so the hook server drops a `PermissionRequest` the mod already asked about (`PermissionBridge.asked`), and the Go hook writes no decision.
  Only an answer from Fleet still skips the settings hooks.
- The hook's input has no `tool_use_id`.
  The registry takes it from the earlier `PreToolUse` with the same tool and input.
  The Go hook sorts the input's keys and the mod keeps Claude Code's order, so the match uses a key with sorted keys (`toolCallKey`).
- `updatedPermissions` from `permission_suggestions` apply as in the dialog: a `setMode` to `acceptEdits` turned the status line to "accept edits on".

## Testing it end to end on Linux

The copilot window is macOS-only (`initCopilot` returns early), so the card cannot be clicked on Linux as shipped.
To check it, change the platform gate locally, enable the copilot in settings with `__FLEET__.stores.settings`, and drive the "Fleet Copilot" page with `agent-browser --cdp <port>`, the port Electron prints as "DevTools listening on" in `.fleet-drive/dev.log`.
Revert the gate afterwards.

`npm run drive -- term-send '<text>' --enter` sometimes leaves the prompt in Claude Code's input unsent.
Send `term-key enter` on its own after a short wait.
In tmux, `send-keys Enter` had the same problem, and `send-keys -H 0d` worked.

A long "Always allow access to <path>" label made the whole session row wider than the panel, because Radix `ScrollArea` lays its content out as a table that grows to its widest child.
A `truncate` button cannot shrink it, since its min-content width is still the full label.
**Fix:** let the label wrap with `[overflow-wrap:anywhere]`.
