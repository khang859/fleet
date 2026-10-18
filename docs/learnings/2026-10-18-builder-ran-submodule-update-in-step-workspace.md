# A builder tried to run `git submodule update` in its step workspace

## What happened

In job j11 of the `journey` test project, one step changed the members `core` and `api`.
Fleet made the step workspace: an umbrella worktree, with `libs/core` and `libs/api` as worktrees on `admiral/j11/version-files-1`.
`libs/web` was not checked out, because the step did not change it.
The brief did not say this.
The Admiral and the builder both thought the submodules were empty, and the builder asked to run `git submodule update --init libs/core libs/api`.
That update checks out the commit the umbrella records, so both members leave the branch.
The commits would then land on no branch, and the branch results would hand back nothing.

## Fix

`stepBrief` now lists the member worktrees in a writer's folder, with their paths and the branch.
It tells the crew member to commit in each one as it is, and not to run `git submodule update` or switch branches.
It also says the other members are not checked out on purpose.
A reader step gets no such note, because it changes nothing.

The branch result card also now shows the member, since every member in a step has the same branch name.

## Rule

When Fleet prepares a folder in a way a crew member would not expect, the brief must say so.
Otherwise the crew member "repairs" it with the usual command.
