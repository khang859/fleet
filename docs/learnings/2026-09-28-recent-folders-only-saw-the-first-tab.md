# Recent folders only saw the first tab

## What happened

The new-agent folder list showed one recent folder while three projects were open in terminal tabs.
`recentFolders` held only `~/Development/unmail`.

## Why

`loadWorkspace` and `switchWorkspace` recorded only `tabs[0].cwd`.
`addTab` recorded nothing at all.
So the list only grew when a new agent was opened, and a restart reset it to the first tab.

## Fix

`recentTabFolders(tabs)` in `src/renderer/src/store/workspace-store.ts` returns the folder of every terminal and agent tab, first pane first, minus worktree tabs.
Load and switch record all of them, last to first, so the first tab ends up at the front.
`addTab` records its folder.
`addRecentFolder` now skips the home folder, where a new tab opens by default, the same way it already skipped the scratch folder.

## Lesson

A "recent" list must be fed by every place the user starts work, not only the one feature that reads it.
Check it live (`__FLEET__.stores.workspace.getState().recentFolders` via fleet-drive) with several tabs open, not with one.

## Also found while testing the folder switcher

A keyboard shortcut that asks for a variant (⌥↵ for "in a new worktree") must do nothing on a row that cannot have that variant.
It first fell back to the plain action, so ⌥↵ on the Scratch row moved the chat instead of being ignored.
