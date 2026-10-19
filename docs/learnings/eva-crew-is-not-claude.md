# eva crew are not Claude crew: check each place that assumes Claude

Date: 2026-10-18
Found while: Phase 4 of `add-admiral-agency` (eva session tracking)

## What happened

1. The runtime check looked for eva's `--hooks` flag with `/--hooks\b/`.
   `\b` sits between `s` and `-`, so the test matched `--hooks-dir` too, and an eva without `--hooks` passed the check.
   A unit test with `--hooks-dir` in the help text caught it.
2. The job sheet's "needs you in its pane" card had one text for every runtime: "a login or trust screen".
   An eva with no hooks file never sends `SessionStart`, so it always shows as needing you, and that text sent the client to look for a screen that does not exist.
   Only the crew row's hover title had an eva text.
3. The sidebar's session list is headed "Claude Code" and shows cost and context from the Claude transcript.
   An eva session showed under it with `$- -%`, since eva tells Fleet neither.

## Fix

1. Match a flag with `(^|\s)--hooks(?![\w-])`: a flag ends at a space or the line end, not at `-`.
2. The card takes the eva text when `member.runtime === 'eva'`, from the same constant as the hover title.
3. An eva row shows `eva` in place of cost and context, and the header reads `Claude Code · eva` while an eva session is listed.

## How to test eva end to end before eva sends hooks

eva 0.3.0 has no `--hooks`, so a hired eva sends nothing.
Send the events it would send through the real hook binary, with the crew pane's id:

```bash
printf '{"session_id":"<eva uuid>","hook_event_name":"Stop","cwd":"<worktree>","pid":<eva pid>,"db_path":"'$HOME'/.eva/sessions.db"}' |
  FLEET_SESSION=1 FLEET_DEV=1 FLEET_PANE_ID=<crew pane id> hooks/bin/fleet-copilot-darwin-arm64 --runtime eva
```

Get the uuid of the newest eva session with `sqlite3 -readonly ~/.eva/sessions.db "SELECT uuid FROM sessions ORDER BY id DESC LIMIT 1"`.
Never read `~/.eva/config.toml` into Fleet: it holds eva's key.
Read what Fleet needs through the shell, and print only those lines (`eva-server.ts`, and the `lock_bypass` read in `availability.ts`).

## eva bypass mode (eva 0.6.0, job j30)

- A `deny` rule holds even under `-b`, and `ask` and `deny` rules from every file combine.
- `--permissions <file>` takes the place of the user's `allow` rules, so Fleet passes it only with `-b`. In default mode it would drop the user's `allow` rules and make eva ask more.
- `lock_bypass = true` in `[permissions]` of any rules file makes `eva -b` exit at start. The `Bypass allowed` check fails then.
- Under `-b`, eva's `PermissionRequest` hook never fires, so eva crew requests never reach the Admiral. `PreToolUse` hooks still run.
- eva has no classifier and no path rule for "outside the worktree", so bypass holds only the push and pull request rules.

## Rule

When a feature gains a second runtime, grep the UI and the prompts for text and numbers that assume the first one, and check each with a screenshot of the second.
