# Workflows: a prompt asked for a tool that its agents did not have

## What happened

The `GitHub issue review` workflow told its agents to read and post with `gh`.
Its agents were read-only, so they had no `bash`.
Each run guessed at the issue, and nothing was posted.
The config check accepted the file, because it cannot read a prompt.

## Fix

Fleet now does the `gh` work, as it does for a PR.
An input with `type = "issue"` makes Fleet read the issue when the run starts.
The finish action `post-issue` makes Post send the report as one issue comment.
Agents stay read-only.

## Surprises

- `.fleet/workflows/` is not in git. A worktree has only `worktree.toml` there, so a branch cannot change those files. The issue pointed at a file that a commit could not reach.
- Zod 4 does not treat `z.unknown()` as optional. GitHub leaves out `pull_request` for an issue, so the parse failed with "expected nonoptional". Write `z.unknown().optional()`.
- GitHub's `issues/N` API also answers for a pull request, with a `pull_request` key. Check that key, or a PR number passes as an issue.
- `author_association` on each comment matters. A stranger can comment on a team issue, so the lock must read the comments too.
- "Run again" sent `trustPr: !run.locked`. That is safe for a PR, as its author cannot change. An issue can get new comments between runs, so "not locked" is not the same as "a person trusted it". A rerun of an issue run now checks the authors again.
- In zsh, `$T` with spaces stays one word, so `npx vitest run $T` found no test files and printed nothing. An empty result is not a pass. Check that a test count shows.

## Rule

If a prompt needs a tool, check the access of that agent.
When a read-only agent needs outside data, let Fleet fetch the data and put it in the brief.
Do not turn "not locked" into trust when the data can change between runs.
