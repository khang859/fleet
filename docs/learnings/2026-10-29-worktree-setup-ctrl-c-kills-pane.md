# Learnings: Ctrl+C in a worktree's setup closed the whole pane (2026-10-29)

## Problem

The first version of worktree setup (`.fleet/worktree.toml`) ran the setup through the pane's one-shot `cmd`.
`PtyManager` spawns that as `<shell> -c "<setup>; exec <shell>"`.
Pressing Ctrl+C during a long setup (like `npm install`) killed the pane's process, so the tab closed and Fleet asked to remove the worktree.

## Root cause

The `-c` shell is not interactive, and SIGINT goes to the whole foreground process group.
The setup command dies, and the non-interactive shell that waits for it exits too, so the `exec <shell>` never runs.
A non-interactive `-c` shell also skips the user's rc files, so tools set up there (nvm, pyenv, PATH edits) are missing from the setup.

## Fix

Setup is now typed into the pane's normal interactive shell, as if the user typed it (`typeOnStart` on the pane leaf, `typeWhenReady` in `src/main/pty-manager.ts`).
It is typed once the shell's startup output has been quiet for 400 ms, which is when the prompt is up, with a 10 s cap.
Ctrl+C now stops only the setup, and the shell stays.
`typeOnStart` is one-shot like `cmd`: `layout-store.ts` strips both before saving, so setup never runs again on restart.

## Rule

Use `cmd` only for a command that should own the pane (like `claude --resume`).
For a command the user may want to stop while keeping the shell, type it into the shell instead.
