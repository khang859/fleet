# Closing a background tab moved the client to another tab

## What happened

Cancelling an Admiral job closes its crew members' tabs.
The client was on the Admiral's tab, but the view jumped to a different Admiral tab.
`closeTab` in `src/renderer/src/store/workspace-store.ts` always set the active tab to a neighbour of the closed one, even when the closed tab was not the active one.

## Fix

`closeTab` now keeps `activeTabId` and `activePaneId` when the active tab is still open.
It picks a neighbour only when the active tab itself closes.
The test in `workspace-store.test.ts` (`closeTab — focus`) uses three tabs, so the old neighbour pick and the kept tab differ; with two tabs the old code passed by luck.

## Lesson

Any code that closes tabs for the client, such as crew teardown, runs while the client looks at something else.
Only a close the client started on the tab they are on may move them.
