# A hook called from App can defeat App's own selector

Issue #541. Typing one character in a file editor re-rendered every pane in every open tab, including the `display:none` ones.
The cause was not in the pane path at all - it was two independent leaks, both invisible at the call site.

## Leak 1: a store action with no equality guard

`setPaneDirty` fires from CodeMirror's `updateListener` on every `docChanged`, so it is called per keystroke.
It had no guard, so after the first character it set `true` over `true` forever, and each call built a new workspace object, a new tabs array, and a new object for *every* tab - not just the one owning the pane.

`App` subscribes with `useShallow((s) => ({ workspace: s.workspace, ... }))`.
`useShallow` compares one level deep, so a fresh `s.workspace` reference fails the check and re-renders `App`, and from there every `PaneGrid`, every pane, and every `useMemo(..., [root])` keyed on `tab.splitRoot`.

The fix is two-part, and the second half matters as much as the first:

1. Return `state` unchanged when nothing actually changed.
2. Make the tree walkers (`updateLeafInTree`, `updateRatioAtPath`) return the node they were handed when no descendant changed.

Without (2) the guard cannot be written: every walk rebuilds the whole tree, so there is nothing to compare.
With it, an update touches only the spine from the root down to the one node it edits, and every sibling subtree keeps its identity - which is exactly what a memoized child needs in order to skip.

`resizeSplit` had the same shape, called per `mousemove` of a divider drag.

The guard has to treat `undefined` as `false`: a never-edited leaf has no `isDirty` key, and both readers of that flag test it truthily.

## Leak 2: hooks that subscribe on their caller's behalf

`App.tsx` carries a comment warning that lifting the notification store into `App` would re-render every pane on each activity tick.
Two hooks called from `App` did exactly that, one line below the warning:

- `usePaneNavigation` - `useWorkspaceStore()` with no selector
- `useNotifications` - `useNotificationStore()` with no selector

A hook body runs in its caller's render, so a bare store call inside it subscribes *the caller*.
`App`'s careful `useShallow` was irrelevant; these two hooks re-rendered it anyway.

Both only needed actions, which are stable references. `usePaneNavigation` also needed live state, but only at keypress time - so `useWorkspaceStore.getState()` inside the handler serves it without a subscription, and the listener binds once (`[]` deps) instead of re-binding on every workspace change.

## The trap in the backstop

`memo(TerminalPane)` on its own would have been inert.
Its `onFocus`/`onSplitHorizontal`/`onSplitVertical`/`onClose` handlers can only be built per leaf, so inlining them inside `layout.leaves.map(...)` hands it four new functions on every grid render.
The memo boundary has to be a component that *owns* those handlers - hence `TerminalLeaf` - so `useCallback` has somewhere to live.

Same trap one level up: `memo(PaneGrid)` needs `App` to pass a `useCallback`'d `onPaneFocus` and a hoisted constant for the background-workspace no-op, or it never skips.

## How it was verified

Store identity is the whole causal chain, so that is what to measure - render counts are a proxy for it.
Against the live dev window over CDP (`npm run drive -- eval`):

- 50 repeated `setPaneDirty(id, true)` produced **1** store notification (was 50), and the first true→false transition still fired exactly once.
- A real divider drag - `mousedown` on the handle, then native `mousemove`s - produced **1** update from 10 identical moves and **5** from 5 genuinely different ones.
- Typing 10 characters into an editor produced 2 workspace objects (dirty on, autosave off) instead of 10.

Two gotchas when driving this:

- The sidebar's own resize handle also carries `cursor-col-resize`. Filter for the pane dividers by their `group/handle` class, or you dispatch into the wrong element and see zero updates with no error.
- Structural tests that grep component source match their own explanatory comments. A comment saying "a bare `useNotificationStore()` here would…" fails an assertion looking for `useNotificationStore()`.

## Rule

A hook that takes no props and returns nothing still has a render cost, and it charges it to whoever calls it.
Before adding one to `App`, check what it subscribes to; and reach for `getState()` whenever the value is only read inside an event handler.
