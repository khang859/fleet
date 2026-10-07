# A finished Claude turn is not `needs_me`

## What happened

Every pane running Claude Code wore the amber "needs you" ring almost all the time.
`PaneActivityBridge` mapped the `waitingForInput` phase straight to `needs_me`, but `waitingForInput` covers two different things: Claude sitting at its normal prompt after a turn (`waitingKind: 'prompt'`), and Claude showing an AskUserQuestion dialog (`waitingKind: 'question'`).
A Claude pane spends most of its life at its prompt, so the ring, the tab badge, the dock count and "jump to needy agent" all fired constantly and stopped meaning anything.

## Fix

`phaseToActivityState` now takes the session and returns `needs_me` only for `waitingForApproval` and a `question` wait.
A finished turn at the prompt maps to `idle`.
This matches `sessionUrgency` in the Claude Code sessions panel, which already called a finished turn `ready` and only approvals and questions `needsYou`.

## Lesson

When one phase has a sub-kind, every place that translates the phase must look at the sub-kind too.
Before adding a new mapping from Claude session state, check `sessionUrgency` so the panel and the pane chrome draw the same line.
