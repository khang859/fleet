# A job opened from the lobby needs a wakeup to plan

## What happened

The Admiral in the lobby opened a job and told the client "the plan will be waiting".
No plan came.
The job thread only takes a turn on a wakeup, and `markHandoff` enqueued none.
So the job sat idle until the client wrote in it again.
Unit tests did not catch it, because they called the job thread by hand.
It showed up twice in end-to-end runs in the dev app.

## Fix

`markHandoff` now enqueues one `event` wakeup the first time a job is handed over.
It tells the job's Admiral to propose the plan with `job_plan`, or to ask what is still missing.
The store test pulls the wakeup queue and checks for it.

## Rule

Any place that hands work to an Admiral thread must enqueue a wakeup.
Check it end to end, not only with a test that drives the thread itself.
