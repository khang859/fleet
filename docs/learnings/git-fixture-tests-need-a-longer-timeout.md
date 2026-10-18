# Tests on real git repositories need a longer timeout

## What happened

`step-workspaces.test.ts` > "runs the setup in the worktree" failed once in a run of 108 test files.
It passed alone, and in three more full runs.
Alone it takes about 2.1 seconds, because it makes real repositories, worktrees and merges.
When the whole suite runs at once, every git process is slower, and the test went past Vitest's 5 second default.

## Fix

Give each `describe` that runs real git a `{ timeout: 20_000 }`, as `workspace-projects.test.ts` already does.
A test that spawns git or a shell gets a long timeout from the start, not after it flakes in CI.
