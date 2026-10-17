# Job workspaces across submodules

## A submodule's git folder has no checkout as its parent

`WorktreeService.removeClean` ran git in `join(gitCommonDir, '..')`.
For a plain repository that is the main checkout.
For a submodule the common dir is `<umbrella>/.git/modules/<name>`, so its parent is `.git/modules`, which is no repository.
Fix: run `worktree remove`, `rev-list` and `branch -D` in the git common dir itself.
Git treats a git folder as the repository, so this works for both kinds.

## Removing a member worktree makes the umbrella look changed

A member worktree added into an umbrella worktree's submodule path (`git -C <member> worktree add <ws>/libs/api`) works, and the umbrella sees it as the submodule.
`git worktree remove` then deletes the folder, and the umbrella shows ` D libs/api`.
After that, `git worktree remove` of the umbrella refuses: "contains modified or untracked files".
Fix: after a member worktree is removed, make its folder again, empty, the way git leaves a submodule that is not checked out.
Then the umbrella is clean and git removes it.

## An umbrella with a member worktree still in it

Git refuses to remove a worktree whose submodule folder holds a checkout.
So the umbrella cleaner keeps the umbrella, with the reason, while any member worktree of the same job workspace is not cleaned.
Retry the member first, then the umbrella.

## The root member must be pinned

The plan check pinned bases only for members a step names.
The umbrella is the job workspace root, so it needs a base even when no step names it.
`MemberFacts.atRoot` marks the member at `.` (the umbrella, or the one repository), and `checkPlan` always pins it.

## Merging member PRs and the umbrella bump (2.24)

Member PRs live in different GitHub repositories, so a merge of one never makes the next one `BEHIND`.
GitHub's `mergeStateStatus` alone cannot tell that the next PR's checks ran before the merge before it.
The merge queue keeps `since` (the time of the last merge) and compares it with the oldest check's `completedAt`.
Older checks are asked to run again once: `gh pr update-branch` when `BEHIND`, else `gh run rerun` for each run of the head commit.

The umbrella bump never checks out a submodule.
`git update-index --cacheinfo 160000,<sha>,<path>` moves the gitlink, and git does not need the commit to exist locally.

`agency-db.test.ts` lists every table of the current schema.
A migration that adds a table must add it to that list too.

A fake `gh` in a test must read `--json` fields at the same index the code sends them.
`gh pr view <url> --json body` has `body` at index 4, not 3; reading the wrong index made the fake answer the wrong shape and the link test fail for a test bug, not a product bug.
