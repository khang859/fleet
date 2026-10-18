# A new status read back as the default

## What happened

Crew hiring added two step statuses, `stopped` and `failed`, to `StepStatus`.
A crew test set a step to `stopped`, and read it back as `pending`.
The write was right: the job log said "Step front stopped".

`PlanStore` checked each row's status against a list, `STEP_STATUSES`, and read any status not in the list as `pending`.
The list was typed `readonly StepStatus[]`, so TypeScript did not see that two members were missing.

## Fix

The list is now a `Record<StepStatus, true>`.
A status added to the union and left out of the record is a type error.

## Rule

When code maps stored text back to a union, keep the known values in a `Record<Union, ...>`, not an array.
An array typed `Union[]` can leave members out without a type error.
