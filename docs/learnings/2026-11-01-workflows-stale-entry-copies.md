# Workflows page: stale entry copies and a list nobody pushed

## What happened

The status of a workflow did not change until a person switched tabs and came back.
The approval modal stayed open after Approve, and the row behind it already said "Ready".

## Why

- `WorkflowEntry` was not part of `WorkflowsState`, so main never pushed it.
  The list loaded only when `WorkflowsView` mounted, and switching the inner tabs remounted it.
- `WorkflowsView` kept a `useState` copy of the entry for the modal.
  The store got the new entry, but `RunSheet` still saw the old `approval`.

## Fix

- Main watches the workflow folders and pushes `workflows:entries` with the project path.
  The path lets the store drop a push for a project that a person left.
- Dialogs keep an id and read the entry from the store.
- `RunSheet` resets its form on the entry id, not the entry object.
  Otherwise each live push would wipe what a person typed.
- Approve sends the hash of the text that a person read, not the newest hash.
  A live list must not turn "approve what you read" into "approve what is on disk".

## Rules for next time

- If a list is state that main owns, main pushes it.
  A refresh on mount hides the bug until a person stays on the page.
- Never put a store row in `useState`. Keep the id and derive the row.
- `fs.watch` goes deaf when its folder is deleted, and a missing folder cannot be watched.
  Watch the parents too, and open all watchers again after each change.
  See `src/main/workflows/folder-watcher.ts`.
- A new `fs.watch` on macOS needs a moment to start, so a write right after it can be missed.
  In a test, repeat the change until it is heard, with a gap longer than the debounce.
  A repeat that is too fast keeps restarting the debounce, and the callback never runs.
