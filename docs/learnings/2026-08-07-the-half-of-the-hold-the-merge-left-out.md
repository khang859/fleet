# Learnings: the half of the hold that a merge left out (2026-08-07)

## The bug

Two branches added something above the composer at the same time.

One held the pane's permission card back until the composer had been quiet for a second, because a card that lands between two keystrokes takes the next key with it.
The other added the pinned strip that subagents ask from.
Neither touched the other's lines, so git merged them without a word - and the strip went straight out onto the screen the moment a child asked, mid-sentence, pushing the composer down under whatever the user was doing.

The strip cannot steal a keystroke the way the card can: nothing moves focus, and Enter never answers a subagent.
What it can do is slide a button under a mouse already on its way to the composer.
The keyboard half of the danger was fixed and the pointer half was not, on the same screen, an hour apart.

## The rule

**A clean merge only proves the two changes did not touch the same lines. Where both sides add something to the same *place* on screen, the invariant one side established has to be re-checked against what the other side put there.**

The question to ask of a conflict-free merge is not "did it apply" but "what did each side promise, and does the other side's code keep that promise too".
Here the promise was "nothing appears over the composer while the user is working", and it was written as a hook that took one question - which is exactly the shape that silently excludes the second source of questions.

Generalising the hook to hold *every* pending question on one clock is what made the promise structural rather than a property of the one call site that happened to exist when it was written.

## The trap in the fix

A hold has two failure modes and only one of them is obvious.

- Too eager: a question drawn while the user types. That is the bug.
- Too greedy: a question that was already up disappearing because the user started typing again, or because a *second* question arrived and the whole set went back behind the hold. That would leave a turn stopped on something no longer on screen.

So the release has to be remembered per question - by request id - rather than as a single "the composer is quiet" flag.
Filtering the live pending set against the released ids gets the way out for free: a question that has been answered leaves immediately, since the hold is only ever on the way in.

## The unrelated bug the fixture found

A hand-written drive fixture built tool calls without the `task` field that subagents added, and `pendingTaskAsks` crashed the whole pane on `part.call.task.id`.

Not reachable from real data - live events are typed, and replay normalises a missing `task` to `null` through zod (`agent-session.ts`) - so the fix was the fixtures, not a defensive check in the renderer.
Worth writing down anyway: **a fixture is a second, untyped writer into the store, and it goes stale the moment a field is added to what it fakes.**
When a feature adds a required field to something a fixture builds, the fixtures are part of that change.

## How it was verified

`npm run drive -- fixture agent-task-permission-ask`, driven from a script that types across the arrival and polls the store and the DOM together, which is what separates "pending" from "on screen":

| scenario | question pending | strip drawn |
|---|---|---|
| idle | 1.5s | 1.6s |
| typing through the arrival | 1.5s | 4.4s (1s after the last keystroke) |
| second question while typing | 4.0s | 7.1s, **first one never left** |

The third row is the one worth the trouble of scripting: it is the only one that can tell a hold apart from a hide.
