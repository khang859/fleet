# A tab's stored label is stale unless the user set it

## What happened

The Claude Code section of the sidebar named a session's row after `tab.label`.
For a tab opened in the home folder, every row read `knguyen`, even after the shell had moved into a project and Claude was running there.
The Orchestrator's session labels (`layoutStore.placeOf` in main) copied the same naming and had the same bug.

## Why

`addTab` sets `label` to the basename of the folder the tab opened in, and nothing updates it afterwards.
The tab list never shows that stored value for an unnamed tab: `TabItem` renders `labelIsCustom ? label : cwdBasename(liveCwd)`.
So `tab.label` only means something when `labelIsCustom` is true.

## Fix

Both places now treat the tab name as absent unless `labelIsCustom` is set, and fall back to the session's `projectName`, the basename of the folder Claude Code itself reports in its hook events.
That folder does not depend on the shell reporting where it is, which it only does at a prompt (see `cwd-poller-must-outlive-osc7.md`).

## Rule

Never display `tab.label` (or `leaf.label`) without checking `labelIsCustom`.
For an unnamed tab, derive the name from a live source: the cwd store in the renderer, or the session's own `cwd` for anything about a Claude Code session.
