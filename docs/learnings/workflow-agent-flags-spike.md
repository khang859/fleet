# What Claude Code and Pi flags really do in a workflow pane

Spike for `openspec/changes/workflow-stages-and-builder`, on 2026-11-01, at commit `8c94695d`.
Versions: Claude Code 2.1.316 and Pi 1.4.0.
All checks ran by hand in a real dev pane with `fleet-drive`, in a small test repo.

## Traps

**`--add-dir` eats the message.**
It takes many values, so `claude --add-dir <dir> 'Start now.'` reads the message as a second folder.
Claude Code opens and waits with an empty prompt, and nothing reports a problem.
Put `--add-dir` before another flag.

**Pi brings back the old tool list on resume.**
With no `--tools`, a resumed Pi session restores the tools named in its transcript (`_restoreToolsFromTranscript`).
So a session that started read only stays read only, even with the normal flags.
The model then says that it has no edit tool, and this looks like a model mistake.
Add the tools by name: `--tools +edit,+write,+bash`.
A full `--tools` list does not restore, so read-only flags on resume still limit the session.

**Pi can stop at a trust question that Fleet cannot see.**
With the default `defaultProjectTrust: "ask"`, Pi asks before it starts if the project has `.pi` files.
The Fleet extension has not run yet, so no session exists in Fleet.
This owner's settings use `"always"`, which hides the stop.
To test it, set `PI_CODING_AGENT_DIR` to a folder with an empty `settings.json`.
Pass `--no-approve` or `--approve` for any pane with no person.

**Claude Code keeps an old plan request after an answer in the pane.**
After "Tell Claude what to change" in the terminal, the old `toolUseId` stays in `pendingPermissions` next to the new one.
All of them clear when the agent moves on.
Always use the latest request, as `index.ts:332` does with `.at(-1)`.

**A permission hook is held only when something can answer.**
With no answerer, the request still shows in `pendingPermissions`, but `respondToPermission` has no held hook to answer.
Turn on Copilot in the dev app, or start a run, to test answers.

**`term-send --enter` does not submit in a Claude Code menu.**
The text and the Enter arrive as one paste, so the text stays in the box.
Send `term-key enter` after it.

## Results

| Check                                                                         | Result |
| ----------------------------------------------------------------------------- | ------ |
| Plan text and file path reach main with `--permission-mode plan`              | Pass   |
| `respondPermission` with `deny` and a reason makes a new plan                 | Pass   |
| `respondPermission` with `allow` and `acceptEdits` starts the build           | Pass   |
| `--tools Read,Grep,Glob,AskUserQuestion` keeps `AskUserQuestion`              | Pass   |
| A waiting question shows `waitingForInput` and `waitingKind: question`        | Pass   |
| `--add-dir` read needs no permission                                          | Pass   |
| Fleet tools load with `--tools` and `--strict-mcp-config`                     | Pass   |
| A read-only Claude Code agent has no edit tool                                | Pass   |
| A worktree of a trusted repo shows no Claude Code trust question              | Pass   |
| A read-only Pi agent has no edit tool                                         | Pass   |
| Pi reads a file outside its folder with no stop                               | Pass   |
| `fleet_*` tools load late in Pi under the allowlist                           | Pass   |
| `sendPrompt` reaches an idle Pi                                               | Pass   |
| A Pi turn end shows `waitingForInput`                                         | Pass   |
| Pi resume with `--no-approve --tools +edit,+write,+bash` keeps talk and edits | Pass   |

## Checked in the build

These were open after the spike, and the build closed them.

- `fleet_draft_save` and `fleet_plan_submit` load in Pi. `fleet_draft_save` loads in Claude Code too.
- Approval in the Claude Code terminal works with no answer from Fleet. `PostToolUse` of `ExitPlanMode` shows it, the run sets `planApproved`, and the wait clears.
- The `run` flag and the reminder path work in real run agents.

## Plan build mode

The plan page starts on `auto`, the first choice in Claude Code.
With `acceptEdits`, each Bash command stops at a permission question.
