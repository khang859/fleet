# A stored schema narrower than its type drops the row's data

## What happened

Phase 6 added a third plan-check severity, `accept`, for eva steps whose cost Fleet cannot measure.
The type `PlanIssue['severity']` got the new value, and so did `plan-checks.ts`.
The zod schema that reads `checks_json` back in `plan-store.ts` still listed only `warn` and `block`.
`parseJsonAs` returns null on a parse failure, so every saved check list with an `accept` issue came back as `NO_PLAN_CHECKS`.
The plan card then had no "I accept" tick box, and Approve was refused with "Accept the steps ... on the plan card first."
A plan with a capped eva step could never be approved from the card.

## How it was found

The Phase 3 auto-start test for "an eva step needing a tick" read `version.checks.issues` back from the store and found it empty.
The pure `plan-checks` tests never went through the store, so they passed.

## Fix

`PLAN_ISSUE_SEVERITIES` in `src/shared/agency-jobs.ts` is now the one list.
The type and the store schema both derive from it, so a new severity reaches both.

## Lesson

- A zod schema that reads a stored row must derive its enums from the same constant as the type, not repeat the literals.
  A narrower schema still type-checks, since its output is assignable to the wider type.
- A lenient parse (`parseJsonAs(...) ?? DEFAULT`) hides drift. Test at least one value of every enum through the store round trip.
