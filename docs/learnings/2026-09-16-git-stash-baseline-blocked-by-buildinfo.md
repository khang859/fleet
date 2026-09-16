# `git stash` to get a baseline, then the pop refuses

## What happened

Mid-feature I wanted to know whether four `tsc` errors were pre-existing or mine.
The check was `git stash push -u`, run `tsc`, `git stash pop`, all chained with `&&` in one command.

The pop failed and the terminal only said `--- restoring`, with no confirmation after it.
Every tracked edit I had made was sitting in the stash and gone from the working tree.

The cause is that `tsc --noEmit -p tsconfig.web.json` rewrites `tsconfig.web.tsbuildinfo`, which is a tracked file.
So the sequence was: stash my work including that file, run the command that dirties it again, then ask git to restore a stashed version of a file that now has local changes.
Git refused, correctly:

```
error: Your local changes to the following files would be overwritten by merge:
	tsconfig.web.tsbuildinfo
Aborting
```

The recovery was `git checkout -- tsconfig.web.tsbuildinfo` and then `git stash pop`.
Nothing was lost, and `git stash show --stat stash@{0}` against `git diff --stat` confirmed the working tree matched the stash before dropping it.

Two things made this worse than it needed to be.

Chaining with `&&` and redirecting to `/dev/null` hid the failure.
`git stash pop >/dev/null 2>&1 && echo restored` prints nothing at all when the pop fails, and the surrounding command's exit code was already non-zero from `tsc`, so there was no signal that anything had gone wrong.

`git stash push -u` also stashes untracked files, and on the retry git reported `already exists, no checkout` for every one of them and then `could not restore untracked files from stash`.
That is why the stash entry survived the first successful-looking pop: git keeps the entry when any part of the restore fails.

## The fix, and what to do instead

Do not use `git stash` for a baseline when the command being tested writes a tracked build artifact.
`tsbuildinfo` files exist precisely to be rewritten, so any `tsc` invocation is in this category.

Better options, in order:

- Ask the narrower question first. The four errors were in `claude-settings-lint.ts` and `copilot-store.ts`, files the feature never touched. `git log -1 --format=%h -- <file>` or simply noting that a file is absent from `git status` answers "is this mine?" without moving anything.
- Use a throwaway worktree: `git worktree add /tmp/baseline HEAD`, run the check there, remove it. The working tree is never disturbed.
- If stashing really is the tool, never chain the pop behind `&&` and never silence it. Run it as its own command and read the output.

## The general lesson

A verification step that mutates the repository is not a read-only check, and treating it as one is how a "quick baseline" turns into recovering your own work.
Before reaching for `git stash`, ask which files the command about to run will write.

Separately: silencing a command's output to keep terminal noise down also silences its failures.
For anything that moves uncommitted work, the output is the only confirmation that it moved.
