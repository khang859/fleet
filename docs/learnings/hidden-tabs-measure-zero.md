# A hidden tab measures 0x0, and a ResizeObserver tells you so

Switching between two image tabs flashed a tiny mirrored copy of the image for one frame.

## What happened

Every open tab stays mounted and the inactive ones are `display: none` (`App.tsx`).
A `ResizeObserver` fires when its target goes to `display: none`, and the target then measures 0x0.
`ImageViewerPane` refits on every observer callback, and its fit maths subtracts 16px of padding from the pane size.
So hiding a tab stored a zoom of `-16 / naturalWidth` - a small negative scale.

Coming back, the observer fired again with the real size, but its `setState` committed in a later task.
The browser had already painted one frame with the stored negative scale at the new size.

## The fix

1. Treat a 0x0 measurement as "not laid out" and keep the zoom that was there.
2. Commit the refit with `flushSync` inside the observer callback.

Observer callbacks run between layout and paint, so a synchronous commit there lands in the same frame as the resize.
Without (2), a window resized while the tab was hidden would still paint one frame at the old zoom.

## How it was found

A `requestAnimationFrame` sampler run through `npm run drive -- eval` logged each `<img>`'s rect and transform per frame across a `setActiveTab` call.
The bad frame showed up as `16x16 scale(-0.03125)`.
A screenshot cannot catch a one-frame glitch; a per-frame log can.

## The general rule

Anything that measures its container must expect 0x0 while its tab is in the background.
A window-level `keydown` listener has the same blind spot: every hidden viewer hears the key.
Check `offsetParent` (null under `display: none`) before acting on it.
