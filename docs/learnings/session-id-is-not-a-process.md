# A Claude session id is not a process

Copy a tab, run `claude --continue` in the copy, then quit it.
The sidebar showed no Claude row at all, even though the first tab still ran Claude.
At other times the sidebar showed two rows for one folder.

## Cause

`ClaudeSessionRegistry` keyed its entries by `sessionId` alone.
A conversation resumed in a second pane runs as a second Claude process with the same session id.
Both processes wrote their hook events into one entry, so the entry flipped between the two panes.
When one process sent `SessionEnd`, the shared entry ended, and the row of the process that still ran went away too.

The dev log showed it: a `SessionStart` for one id came from pane B while the pid in pane A still ran.

## Fix

An entry is keyed by `sessionKey({ paneId, sessionId })`, from `src/shared/claude-sessions.ts`.
Each process has its own phase, permissions, sidebar row, prompt input, pane badge and mod prompt poll.
Things that belong to the conversation stay keyed by `sessionId`: the transcript, usage, git and the conversation reader.
They are only dropped when no entry for that id is left.

`registry.get(sessionId)` with no pane returns the live entry that was active last.
Code that knows the pane must pass it, or it can act on the wrong process.

The fleet-bridge mod now sends `pane` (from `FLEET_PANE_ID`) on its prompt poll, and Fleet answers a poll without it with 404.
No older mod can still be asking: Fleet copies the mod in when it starts, and its panes do not outlive it.

## Rule

Do not use a Claude session id as the identity of a running process.
The pane is the process; the session id is the conversation.
