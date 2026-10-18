# Claude Code trusts a job worktree only through the main checkout

Date: 2026-10-18
Found while: Phase 5 of `add-admiral-agency` (permission end to end test)

## What happened

A crew member in a job worktree of the fleet repo started at once.
A crew member in `jobs/N/ws/<slug>/libs/core`, a submodule worktree in the journey repo, stopped at Claude Code's folder trust prompt.
Fleet never answers that prompt for crew, so the job waited.

## Why

Claude Code takes trust for a git worktree from the main checkout's root.
The fleet checkout is trusted, so each fleet job worktree is trusted too.
A submodule worktree belongs to the submodule's own repository, not the journey checkout, and that folder was not trusted.

## Fix

Nothing in Fleet changed: the trust prompt is the user's to answer.
The end to end test moved to the fleet repo with a scratch `e2e` remote.
A job that needs crew in a submodule shows the member as `needs you` until the client answers the prompt in its pane.
