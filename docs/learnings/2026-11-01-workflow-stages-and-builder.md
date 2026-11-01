# Workflow stages and the builder pane: what went wrong in the build

Build of `openspec/changes/workflow-stages-and-builder`, on 2026-11-01, on commit `8c94695d` with work not committed yet.

## Mistakes and fixes

**A failed worktree or a dirty tree made a bad PR.**
`openBranchPr` had no check for work with no commit, so a PR could miss work.
It now refuses, saves `run.prProblem`, and the run page has a retry button.

**The finish action list is closed.**
`action` takes only `save-report`, `post-pr` and `open-pr`.
A test file with `show-report` was refused. To show the report, leave out `[finish]`.

**Test panes read the wrong `gh`.**
The `fleet-drive` daemon keeps the environment it started with.
`restart` through an old daemon dropped `ZDOTDIR`, so the stand-in `gh` was not on `PATH`.
Kill the daemon, then start `up` with the new environment.

**`workflow-draft` is not a normal pane.**
A draft leaf has no terminal, so `tabFromLeaf` and `canMovePane` must refuse it.
`isDraftLeaf` in `workspace-store.ts` does this.

**A panel on the wallpaper was hard to read.**
`DraftPane` had a clear background. It needs `bg-fleet-surface`.

**The stage map was cut in a narrow pane.**
A row of columns has no room beside a terminal. `ReadOnlyMap` runs top to bottom in `StackedColumns`.

**`term-send --enter` can stay in the box at a Claude Code prompt.**
Send `term-key enter` after it. This goes beyond the menu case in `workflow-agent-flags-spike.md`.

## What `ripwire . --quality-delta` still reports

It exits 2, with 114 gating rows. I left them, for the reasons below.

- **Dead code, 37 rows.** All are false. Each symbol has a use in `src`. Most are React components used in JSX.
- **Duplication, 45 rows.** I read the largest pairs, and they have the same shape with another meaning, such as `finish` and `submitPlan`. Most other rows are one-line predicates. I did not read each one.
- **Churn, 90 rows.** This is a large change to many files.
- **Size, 24 rows.** This one is real. `WorkflowRunManager` grew from 935 to 1219 lines, and `WorkflowsService` from 465 to 543. A later change should split them.

## Not checked

- A real GitHub PR. The run used a stand-in `gh` and a local `origin`. The flags in `pr.ts` match `gh pr create --help` in `gh` 2.103.0.
- A plan answer from Copilot. It shares the code path, and only unit tests cover it.
- The Windows UI.
