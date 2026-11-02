# One trust flag for two workflow targets

## What happened

A workflow can have a PR input and an issue input.
Both used one `trustPr` flag, so "Trust this PR" also trusted the issue.
The trust also stayed on when a person typed a new number in the run sheet.
The duplicate key used only the PR number, so a second issue on one PR counted as a duplicate.
The preview added the GitHub check for a blank optional issue, but `start()` did not need it.

## How it was fixed

- `StartRunRequest` has `trustPr` and `trustIssue`.
- `trustAfterEdit` in `RunSheet.tsx` drops the trust of an input when that input changes.
- `targetOf` puts both numbers in the key, for example `pr:12 issue:9`.
- The preview uses `namesIssue`, as `start()` does.
- "Run again" sends `trustPr: !run.locked` and never sends `trustIssue`, so `trustsOnRerun` is gone.

## What to remember

- Give each thing a person can trust its own flag, and end the trust when the thing changes.
- The Trusted badge comes from the local choice, and the Locked badge and Trust button come from the preview.
  The preview is 350 ms or more behind, so a UI test must wait for the Trust button to go before it reads the state.
- The fake `gh` in `starts.test.ts` gives one fixed issue number, so a test with two issues needs two fakes.
