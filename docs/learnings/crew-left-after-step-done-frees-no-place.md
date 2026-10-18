# A crew member that leaves after its step is done must still free its place

## What happened

The stack slot test let the first QA step finish with `job_update done`, then closed its pane.
The second job's QA step stayed queued, although no crew member ran the stack any more.

## Why

`JobsService.crewLeft` returned early when the step was no longer `running`, so it never called `admitQueued`.
`job_update done` had called `admitQueued` already, but at that moment the member was still live and still held its place.
Nothing called it again once the member really left.
The crew limit queue had the same gap.

## Fix

`crewLeft` now calls `admitQueued` on that early return too.
The stack slot poll also lets queued stack steps go every 10 s, so a fixed port that comes free is seen.

## Rule

A place in a queue is freed by the thing that held it going away, not by the step status.
Call `admitQueued` on every path where a crew member ends, even when the step has moved on.
