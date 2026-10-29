# Telescope sidebar jumped home after opening a file

## Symptom

The Telescope browser sidebar follows the focused pane's folder.
Opening a file from it (click or Enter) made the sidebar jump to `~`.

## Root cause

`App.tsx` passed `cwd={focusedPaneCwd ?? window.fleet.homeDir}`.
`focusedPaneCwd` comes from `cwd-store`, and only terminal panes put entries there.
`openFile` creates a file pane and makes it the active pane.
That pane has no cwd entry, so the fallback `homeDir` became the new folder to follow.

## Fix

`TelescopeSidebar` takes `cwd: string | undefined` and keeps the last pane that had a folder.
An undefined cwd (file viewer, editor, settings) leaves the sidebar where it is.
It also keeps that pane's id, so Shift+Enter still pastes into the last terminal.

## Lesson

Anything that "follows the focused pane" must treat panes without a cwd as "no change", not as "go to a default".
Falling back to a default turns every non-terminal focus into a jump.
