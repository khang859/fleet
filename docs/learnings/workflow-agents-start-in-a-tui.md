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
