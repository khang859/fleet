# Refuse a close before disposing what it would close

## What happened

Fleet's pinned tool tabs (Annotate, Sessions, and now Scratch) cannot be closed.
`closeTab` and `closePane` enforced that by filtering the tab out of the layout update, which is a no-op for a pinned tab.

But both functions disposed the pane's resources *first*, before the state update that would decide whether the close was allowed.
For Annotate and Sessions that never mattered, because neither holds anything a disposer touches.
Scratch is the first pinned tab that is a live agent pane, and disposal cancels its turn and throws away its thread.

So closing the Scratch tab cancelled the running turn and emptied the conversation, then refused the close.
The tab stayed open, blank, and holding a session the pane would not reload, because none of its props had changed.

## Why it was easy to miss

"The close did nothing" and "the close was refused" look identical until the thing being closed owns state.
The guard read as correct because the tab really did survive.
Nothing in the layout tree records that a disposer already ran.

## The second half of it

The first fix was a blanket tab-level guard, and that was wrong in the other direction.
Scratch is an ordinary agent tab, so it can hold splits: a terminal opened beside the conversation for a handoff is the user's to close.
Refusing every pane close in a pinned tab froze those in place.

What is actually pinned is the tool, not the tab's geometry.
`isToolPane` says a pane is the tool when removing it would empty the tab, or when it is the `agent` leaf of a Scratch tab.
Everything else in there closes normally.

## The rule

Order the guard before the side effect, always, even when the side effect looks inert today.
`get()` the current state and decide, then dispose, then `set()`.
And when a class of thing gains its first stateful member, re-read every place that treats the class uniformly: the uniform treatment was only ever correct for the stateless members.
