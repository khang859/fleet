# Stopping dev to run tests interrupted a live Admiral job

Date: 2026-10-18
Found while: grouping the Admiral's crew rows and removing `fleet_wait`

## What happened

The user had a real Admiral job (j20) running in the dev app, with crew working in their panes.
To run Vitest, the agent ran `npm run drive -- stop` and `npm rebuild better-sqlite3`, because the main-process tests need the Node build of `better-sqlite3` and dev needs the Electron build.
Stopping dev ended every crew pane.
After the restart, the job showed "Fleet restarted while the crew were working" and waited for the user to pick Resume.

## Fix

Nothing was lost: Resume puts the same crew member back in the same worktree.
The user was told, and the agent did not answer the card for them.

## Rule

Before stopping or restarting dev, check for live crew: `__FLEET__.stores.agency.getState()` through `npm run drive -- eval`, or the job tabs.
If the user has a job running, run only the tests that need no native module (renderer tests), and leave the rest to CI or ask first.
