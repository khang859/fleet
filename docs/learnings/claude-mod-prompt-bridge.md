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
