# Workflow approval view: a new dependency and a hidden effect of order

## What happened

The readable approval modal added the `diff` package, but `src/shared/agent-diff.ts` already had a line diff.
It also said "Only comments, spacing or order changed" when two agents swapped places.
That text was wrong for one case: `src/main/workflows/posting.ts` uses the first agent's program to post findings.

## Fix

- `workflow-review.ts` uses the shared `diffLines`, and the `diff` package is gone.
- A PR workflow has a Posting row, so a new first agent shows as a changed setting.
- `ChangeView.test.tsx` is the first rendered test in the repo. A `.test.tsx` file sets `// @vitest-environment jsdom` on its first line.

## Rules for next time

- Search `src/shared` by behavior before you add a package. Name search misses a helper with a general name.
- An approval view must show what a file causes, not only what a file says.
  Before a view calls a change harmless, search main for code that reads that field, including `[0]` on a list.
