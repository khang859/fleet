# Workflow agents start in a TUI, so a start can wait on a person

## What happened

A workflow run with a Claude Code agent failed with "It did not start in time."
The pane was fine.
Claude Code stood at its "Do you trust this folder?" question, so it never sent `SessionStart`.
The deadline treated a slow start as a dead agent, and the pane stayed open with the question on screen.

## The fix

A late start in a manual run stays `starting` and sets Needs you, so the person can answer in the pane.
`SessionStart` then clears the flag, and the run goes on.
An automatic run has nobody to answer, so it still fails at the deadline.

## What to remember

- An agent in a TUI can stop at its own question before any hook fires. Its silence does not mean that it died.
- A new worktree is a new folder, so Claude Code can ask this question again for each PR run.
- `notify` runs before `settle`, so `run.state` is still old during `notify`. A filter on notices must read the agents, as `needsPerson(run)` does, and not `run.state`.
- A personal workflow appears in every project. Its approval must follow the file, not the project.

## Findings from the review after the build

Three reviews read the finished code.
These are the mistakes that are easy to repeat.

- Each event handler must check the agent state and the run state.
  `onApiFailure` had no check, so an error in a follow-up turn brought a finished agent back.
- A run that resumes must handle every agent state, not only `failed`.
  `goOn` skipped `pending` agents and a missing worktree, so the run could not finish.
- Count what is about to start.
  A `preparing` run has `pending` agents, so a drain loop saw room for every queued run.
- After a sleep, reset each clock that can flag an agent, not only the deadlines.
- Keep what a run needs after a restart in the run record.
  `teamPr` lived in a map, so a resumed run lost it.
- Compare the hash of the bytes that run, not the hash of an earlier read.
- A pane that leaves a run must not read as `outside`, because outside panes get more tools.
- An agent can name a folder, so check that folder is open in Fleet before a write.
- A repo can ship a symlink at any path, so check the target before each write.
- Name checks need lower case on macOS and Windows.
- A person who confirms a post must see the text, not only a count.

## Findings from the first PR review

A run read the PR number from the repo-wide `FETCH_HEAD`.
A second run could overwrite that file, so the first run reviewed the wrong commit.
Each run now fetches into its own ref, `refs/fleet/runs/<runId>`, and removes the ref after.
A test with real git and six runs at once showed the bug, as a fake `exec` cannot.

An `await` gives a person time to change things.
The scheduler held an old rule across the PR poll, so a deleted rule could still start a run.
Read the rule again after each wait.
The worktree had the same problem: it could finish after its run closed, so `prepareWorktree` now checks the run after the wait.

A failed command does not always mean that nothing happened.
A timeout can hide a comment that went out, so a retry looks for the item's hidden mark on the PR first.

A partial list looks the same as a full list.
With 50 PRs per read, an old PR looked new when it moved onto the first page.
`listOpenPrs` now reads all pages and asks `--jq` for only the fields a rule needs.

## Terminal replies are not typing

xterm sends its status replies through `term.onData`, the same stream as the keyboard.
A Claude Code or Pi TUI asks for these replies when it starts, so every agent looked as if a person had typed in it.
Fleet then kept all the panes open when a run finished, and only a live run showed this.
`isPersonInput` now drops status, focus, mouse and title replies before Fleet counts a person.

## Findings from the second PR review

A resume loop must check the run state after each await, the same as the first start.
A stop during a slow pane open otherwise lets the loop start the next agent.

The agent limit must count agents that a run is about to open, not only those that started.
Pending agents look like free room while panes open one at a time.

`gh` and `origin` can name different repos in a fork, and each repo has its own PR numbers.
Fleet now fetches from the remote of the repo that `gh` reads, and it refuses when no remote matches.

A name check on the spelled path misses a symlink inside the project.
The report path check now also reads the real path.
`unsafeTarget` stays free of the name check, because workflow files live in `.fleet/`.

## Testing Post without a real PR

The app replaces PATH after it starts, so a fake `gh` on PATH or in the sandbox `bin` folder does not work.
A local git remote named `<owner>/<repo>.git`, and a one-line local change in `runProgram` that points `gh` at a script, gave a full live test.
Restart the dev app after you revert that line, or the app goes on with the fake `gh`.
