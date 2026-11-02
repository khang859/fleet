# E2E cleanup with `rm -rf .fleet` deletes a tracked file

While testing Workflows by hand, I seeded `.fleet/workflows/*.toml` in this repo and then cleaned up with `rm -rf .fleet`.
That also deleted `.fleet/worktree.toml`, which is checked in.
`git status` showed it as ` D .fleet/worktree.toml`, and `git checkout -- .fleet/worktree.toml` brought it back.

## What to do instead

- Remove only what you made: `rm -rf .fleet/workflows`, not the parent folder.
- Run `git status --short` after any cleanup, before you call the work done.
- Personal workflows for the dev app live in its sandbox, `~/.fleet/dev/<id>/workflows/`, so clean that folder too.
