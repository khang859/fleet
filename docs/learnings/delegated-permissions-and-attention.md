# A request held for the Admiral is not one the user must answer

Date: 2026-10-18
Found while: Phase 5 of `add-admiral-agency` (crew permissions)

## What happened

1. Each crew permission request made the crew session `waitingForApproval`.
   The sidebar showed "1 needs you / approve", the crew pane got an amber ring, and the OS could notify, even while the Admiral answered the request on its own.
2. A request on the client's card did not light the Admiral pane, because its waiting count had questions, plans and results, but no permission cards.
3. After the fix for 1, the Admiral sat in `fleet_wait` and let a request time out after 90 seconds.
   Its wait woke on `waitingForApproval`, and crew sessions no longer showed that phase.

## Fix

1. `addPermissionAnswerer(canAnswer, { delegates: true })` marks an answerer that takes requests to the user its own way.
   The registry sets `delegated` on a request such an answerer can take, before the phase reducer runs, so the session stays `processing`.
   Only requests that are not delegated make `waitingForApproval`.
2. `AgencyJob.permissionsWaiting` lists the requests on a card or in the crew pane.
   `waitingCount` counts them, and `waitingKeys` adds `p<id>`, so a new card notifies once.
3. `scopeFleetToCrew` shows the Admiral each crew session through `asAnswerer`: a held request reads as `waitingForApproval` again, so its waits and reads see it.

## Rule

One session state can mean different things to different readers.
When you change what a phase means for the user, check every reader of that phase, including the agents' own wait tools.
