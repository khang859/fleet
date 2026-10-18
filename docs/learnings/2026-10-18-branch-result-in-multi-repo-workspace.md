# A branch result named the wrong member in a project of several repositories

## What happened

In the `journey` test project (an umbrella with the submodules `core` and `web`), a builder fixed the umbrella README and committed on `admiral/j9/fix-1`.
The Admiral delivered the branch with `job_deliver` and no `member`.
The Local branch card showed `04332dc`, which is the base of `core`, not the fix commit `978d89e`.

A step workspace gives every member worktree the same branch name.
`buildBranch` took the first member that had the branch, and that was `core`, where the branch had not moved.

## Fix

With no `member` given, Fleet now compares each member's branch head with the base its job worktree was made at (`job_resources.base_sha`).
It takes the one member where the branch moved.
When the branch moved in more than one member, it refuses and asks for one delivery per member, with `member` set.
A test in `src/main/agency/workspaces/__tests__/step-workspaces.test.ts` covers both cases on real git.

## Rule

In a project of several repositories, a branch name does not identify a repository.
Look up the job's resources to find where the work is.

## Side note: the shell rewrites git output

This machine has a Claude Code hook that runs `git` through `rtk`, which prints a short summary in place of the real `git diff` output.
A patch saved with `git diff > file` was not a valid patch.
Save a patch with `command git diff` or `/usr/bin/git diff`, or do not stash work through a patch file.
