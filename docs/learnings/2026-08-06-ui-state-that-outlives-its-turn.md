# Learnings: a spinner that outlives the turn it belongs to (2026-08-06)

## The bug

The agent task panel drew an `in_progress` item with `<LoaderCircle className="animate-spin">`.
The mark was chosen from the item's status alone, which is the obvious thing to do and is wrong.

`AGENT_TODO_INSTRUCTIONS` tells the model that an item it could not finish **stays** `in_progress`, and that it should explain why in its reply.
So the designed, intended outcome of a blocked turn was a task spinning forever beside an idle composer - not an edge case in the failure path, but the steady state the instructions ask for.
Pressing Stop mid-item produced the same thing, permanently.

It also directly contradicted a neighbour: `AgentActivity` unmounts when the turn ends, precisely so the pane stops claiming to be working.
Two components disagreed about whether anything was happening.

## The rule

**An animation is a claim about right now, so it has to be driven by something that is true right now.**

Item status is durable content - it survives the turn, the reload and the session.
"Work is happening" is a property of the turn.
Deriving the second from the first alone is a category error, and the giveaway is that nothing in the drawing path can distinguish "started" from "still going".

The fix threads `streaming` (whether `thread.streamId` is set) into the mark: spinning while a turn runs, a static `CircleDot` when not, which reads as *started, not finished* - which is exactly what the item is.

## Where else this shape shows up

Any indicator whose truth is scoped to a process but whose input is scoped to the data:
progress bars fed by a stored percentage, "typing…" fed by a draft field, pulsing badges fed by an unread flag.
Before animating, ask what stops it - if the answer is only "the model writing a different value", it will eventually run forever.

## How it was found

Not by using the app, and not by the tests - it needs a turn that ends with work outstanding, which the happy path never produces.
It came out of a review pass that read the model-facing instruction text next to the rendering code and noticed the two describing different worlds.
Reading the prompt and the component together is worth doing deliberately; they are the same feature and they are easy to change apart.
