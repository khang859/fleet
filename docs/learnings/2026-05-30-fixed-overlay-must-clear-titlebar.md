# `position: fixed` overlays must clear the 36px custom titlebar

Found during the Kanban board smoke test: the task drawer's close `X` was overlapping the OS window controls (min/max/close).

## Cause

The app is a frameless window (`titleBarStyle: 'hidden'` in `src/main/index.ts`). On Linux/Windows the OS window controls live in a `titleBarOverlay` of **height 36**; on macOS they're top-left traffic lights. The renderer reserves that space with a top bar of `h-9` (36px) in `src/renderer/src/App.tsx`, and **all app content sits in the flex row below it**.

`KanbanDrawer` used `fixed right-0 top-0 h-full`, which positions against the viewport — ignoring the `h-9` top bar — so it ran up under the titlebar overlay. Its header (with the close `X`) landed directly beneath the top-right window controls. z-index doesn't help: the OS `titleBarOverlay` always paints above page content.

## Fix

Offset the fixed overlay below the titlebar to match the app's `h-9` top bar:

```diff
- fixed right-0 top-0 z-40 flex h-full w-[420px] ...
+ fixed bottom-0 right-0 top-9 z-40 flex w-[420px] ...
```

`top-9` (= 36px) aligns with the `h-9` top bar; pairing `top-9` with `bottom-0` (instead of `h-full`) keeps it full-height without overshooting the bottom.

## Takeaway

Any `position: fixed` / viewport-anchored element in this app must start at `top-9`, not `top-0` — otherwise it collides with the OS window controls. Don't reach for z-index; the titlebar overlay is above the page regardless. Match the existing `h-9` reservation.
