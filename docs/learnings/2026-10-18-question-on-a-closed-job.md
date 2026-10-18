# A question asked on a closed job kept the Admiral pane yellow

Date: 2026-10-18
Found while: running j20, with j19 closed

## What happened

The Admiral pane stayed yellow ("waiting") while the job sheet said nothing needed the client.
The roll-up counts every open question in the repository.
q14 was open on j19, which had closed 36 seconds before the Admiral asked it.
Closing withdraws a job's questions once, but `ask_client` still took new questions on a closing or closed job.
No tab shows a closed job, so the client had no way to answer q14.

## Fix

1. `AgencyService.ask` refuses a question on a job that is not in `OPEN_JOB_STATES`.
2. Startup withdraws questions still open on a closed, cancelled or failed job, which clears rows left by older builds.

## Rule

When an action clears state once (here: closing withdraws questions), also refuse new state of that kind after it.
