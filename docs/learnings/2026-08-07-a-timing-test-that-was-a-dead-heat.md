# Learnings: a timing test that was a dead heat (2026-08-07)

## The bug

`tools.test.ts > bash > kills what the command started as well` failed in CI and passed on every local run.

The test asked whether the process-group kill reaches a grandchild:

```
command: '(sleep 1; echo late > late.txt) & sleep 30', timeoutMs: 1000
```

The writer sleeps 1000ms and the killer fires at 1000ms, both timed from the same instant.
Nothing separates them but the scheduler.
On a loaded runner, Node holds the timer callback a few milliseconds longer than the shell holds `sleep`, the file gets written, and the assertion fails - with no defect anywhere in the product.

The product was right the whole time: `spawn(..., { detached: true })` plus `process.kill(-pid, …)` in `bash.ts`.

## The rule

**A test that measures whether A happens before B has to make A and B differ by much more than the noise it is running in.**

Equal durations on both sides is not a tight test, it is a coin flip.
The margin has to be sized against how badly a loaded CI runner can delay a timer - hundreds of milliseconds, not tens.

The fix is only wider gaps: kill at 1s, write at 4s, look at 5s.
Three seconds of slack in front of the write, one second behind it, and `timeoutMs` cannot go below 1000 because the tool's own schema forbids it.

## Widening a margin can make a test vacuous, so check

A test that can no longer fail passes for the wrong reason, and this fix is exactly the kind that quietly produces one.
Flipping `detached` to `false` in `bash.ts` and re-running was enough to confirm it still fails when the group kill is broken - then the edit was reverted.

Do that whenever a fix is "make the numbers further apart". It costs one run.

## How it was found

CI, on a commit that touched neither the test nor `bash.ts`.
Two earlier runs on the same branch had passed, which is the signature: same code, different answer.
Reach for the timing margins before looking for a regression in the diff.
