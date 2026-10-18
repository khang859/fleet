# SSR component tests read zustand's initial state

## What happened

A renderer test for the job sheet called `useAgencyStore.setState({ details: ... })`, then rendered `JobSheet` with `renderToStaticMarkup`.
The sheet still showed the empty plan text, as if no detail was loaded.

## Why

`renderToStaticMarkup` reads a zustand store through `getServerSnapshot`.
For a vanilla zustand store that is the store's initial state, not the state after `setState`.
So any data a component reads from a hook is invisible to a server render in a test.

## Fix

Pass the store data into the component as a prop, and read the hook one level up.
`AdmiralPane` calls `useJobDetail(jobId)` and passes `detail` to `JobSheet`.
The test then passes the detail it wants straight to `JobSheet`.

## Also seen in the same change

- A test of the plan loop check used a duplicate step id.
  The duplicate made the graph map keep only one of the two steps, so the loop was never built and the test failed for the wrong reason.
  Keep each check's test to one fault: one test for duplicates and unknown steps, one for the loop.
- `npm test` output is cut down by rtk to `PASS (n) FAIL (m)`.
  To see a failure, read the newest tee log: `ls -t ~/Library/Application\ Support/rtk/tee/*vitest* | head -1`.

Repeated on 2026-10-17 with `JobLinkLine`: the test set the store and the render still saw an empty snapshot.
The fix was the same: move the decision into a pure helper (`jobLink` in `job-view.ts`) and test that.
Do not return a new object from a zustand selector to avoid this, since that renders in a loop; select the snapshot and call the helper after.

Repeated on 2026-10-18 with `MeetYou`: it read `onboarding` from the agency store, so every test rendered "Saving…".
`AdmiralPane` now passes `onboarding` down as a prop.
Before writing an SSR test for a new component, check which hooks it reads, and lift them to the parent first.
