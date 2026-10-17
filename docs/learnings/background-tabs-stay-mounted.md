# Panes in background tabs stay mounted

## Question

The Admiral only runs turns while its pane is mounted, because main never starts an agent turn and the renderer pulls due work.
So before building it, we checked whether a pane in a background tab keeps running.

## What we found

It does.
`App.tsx` renders every tab of the active workspace and hides the inactive ones with `display: none`.
Background workspaces are rendered the same way, hidden.
Nothing unmounts on a tab switch.

The one exception is the first launch: `useDeferredTabMount` mounts non-active tabs one per idle slice, so a background tab can mount a moment after the active one.
Once mounted, it stays mounted until the tab or pane is closed.

## How we checked

With `npm run drive -- up`, we opened an Agent pane, kept a reference to its composer textarea, and switched to another tab:

```js
window.__mark = [...document.querySelectorAll('textarea')].find((e) => e.offsetParent !== null);
// switch tab, then:
({ connected: window.__mark.isConnected, visible: window.__mark.offsetParent !== null });
// -> { connected: true, visible: false }
```

## What it means

The Admiral pane needs no hidden mount.
Wakeup delivery should still live in a store subscription, not in a component effect, so it keeps working during the deferred first mount.
