# A gate refused by reservations is not a job over budget

Date: 2026-10-18
Found while: Phase 6 of `add-admiral-agency` (budgets and spend)

## What happened

1. `budgetCard` put up a "Raise the monthly cap" card for any refusal that had a cap in it.
   A gate refused only because another job's reservation was under way returned `busy`, and the job still got a cap card.
   The client was asked to raise a cap that was not reached.
2. A test cancelled a job and ended at once.
   Cancel starts the job cleanup without waiting for it, so the cleanup ran after `afterEach` closed the database.
   Vitest then printed an unhandled "The database connection is not open" error, from a test that had passed.

## Fix

1. `budgetCard` returns null unless `cap.reason === 'cap'`.
   A `busy` refusal holds nothing and makes no card: the work tries again when the reservation is released.
2. The test awaits `service.cleanup.start(job.id)` after the cancel, so all the work the cancel started ends before the database closes.

## Rule

A refusal can mean "over the limit" or "wait a moment".
Only the first one asks the client for anything.
In tests, await every piece of work an action starts in the background before teardown closes what it uses.
