# Admiral pane - Phase 1 review and E2E bugs

## A split tab kept the "Admiral" label after the Admiral pane closed

`closePane` rebuilt the tab's pane tree but kept `type: 'agent'` and the Admiral label.
The tab then looked like an Admiral tab with only a terminal in it.
Fix: `withoutAgent(tab)` in `src/renderer/src/store/workspace-store.ts` turns an agent tab with no agent or Admiral leaf back into a terminal tab, labelled after the first leaf's cwd.
Lesson: when a tab's type comes from its panes, recompute it every time the pane tree changes.

## The composer draft was lost on a job tab switch

Each job tab mounts its own `AgentThread`, so the `Composer` state died with the old mount.
Fix: a module-level `drafts` map in `AgentThread.tsx`, keyed by thread, seeds and saves the text.
Lesson: state that must outlive a remount cannot live in `useState` alone.

## A second question did not alert the user

`publishActivity` skipped a report when the state did not change, and "needs input" stayed "needs input".
Fix: a `renotify` flag on the activity report, set by the Admiral runtime only when a new question id shows up.

## Wakeups stayed claimed after a window reload or pane close

The claim on the repo was released, but the wakeups the old pane pulled stayed claimed until the stale-claim timer.
Fix: `AgencyService.release` and `releaseOwner` call `store.unclaimWakeups(repoId)` for each repo they drop.

## Fences matched only lower case

`</FLEET-DATA>` in a body slipped past the fence escape.
Fix: the fence and unfence regexes in `src/shared/fleet-tools.ts` use the `i` flag.
