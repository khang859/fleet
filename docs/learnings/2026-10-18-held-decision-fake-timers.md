# Held decisions and fake timers

## What happened

The Bridge holds a plan approval for 5 seconds in main, so the client can undo it.
A test moved fake time past the 5 seconds and then checked the result at once.
The result was still null, and the test failed.

## Why

Only `setTimeout` was faked.
The timer fired on time, but the approval then runs its pre-approval checks, and those read git and files with real async work.
`vi.advanceTimersByTimeAsync` flushes microtasks only, not real I/O, so the approval had not settled yet.

## Fix

Keep the promise that `hold` returns, and `await` it after moving time.
Check intermediate state (still held, not yet run) through a tracker that does not await.
Do the same for any held decision whose run path does real async work, such as a refusal from the approval's own checks.
