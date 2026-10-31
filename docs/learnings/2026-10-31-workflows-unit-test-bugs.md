# Workflows backend: bugs the first unit tests found

Writing tests for `src/main/workflows` found bugs that live runs did not show.

## A shared "empty" value is state

`SignedFile.read()` returned `this.empty` by reference, and callers changed what they read.
The first approval then lived inside `empty`, so a tampered file read as "approved" until restart.
`EMPTY_RULES` was changed the same way.
Fix: `structuredClone` the empty value on each read.

## An append-only log must expect half a line

Skipping a half line on read is not enough.
The next append landed on the same physical line, so that entry was lost too.
Fix: the first write of a launch starts with a new line.

## Check state after every await in a start flow

`launch` set `running` after `await makeWorktree`, so a stopped run came back to life.
A pane killed while it was still opening also survived, as the kill found nothing.
Fix: check `isActive` after each wait, and kill again when the agent no longer owns the pane.

## Sleep must not spend deadlines

Keeping sleep out of `activeMs` was not enough.
The start deadline and the limit grace read the wall clock, so waking up failed agents and stopped runs.
Fix: move those two marks forward by the sleep gap.
