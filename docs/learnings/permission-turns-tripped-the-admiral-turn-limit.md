# Crew permission requests tripped the Admiral's turn limit

## What happened

On job j30 the QA crew member asked for a permission every few seconds.
The Admiral answered each one in its own turn, and `pullWakeups` counted every turn as an automatic one.
After 20 approvals the job stopped behind a "The Admiral took 20 turns in a row on its own" card.

While the job waited on that card, `pullWakeups` returned nothing at all, so the next permission request never reached the Admiral.
After 90 seconds it went to the client, expired three minutes later, and fell back to the crew member's pane.
The crew sat waiting, and the Admiral looked idle.
Earlier the same day three requests were denied the same way, as "the card expired".

The same job's PR also came to conflict with `main`, and nothing told the Admiral.
Fleet looked at `mergeStateStatus` only when it merged, not while it watched open PRs.

## The fix

- A crew permission request wakes the Admiral with its own wakeup kind, `permission`.
  `pullWakeups` does not count a turn of only `permission` wakeups, and still brings them to a job held at the limit.
  Every other wakeup still counts and still waits.
- `gh pr view` now asks for `mergeable`, and `PrState.conflicts` holds it.
  `UNKNOWN` keeps what was known, since GitHub works it out lazily.
  When an open PR comes to conflict with its base, the Admiral gets an event, and the PR card says "Conflicts with <base>".

## Takeaway

A guard against the Admiral running away must count only what the Admiral starts itself.
Work the crew is waiting on is not a runaway loop, and blocking it stalls the job instead.
