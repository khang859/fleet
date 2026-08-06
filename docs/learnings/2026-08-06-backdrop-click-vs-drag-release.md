# Click-outside-to-close must check where the press started

Found while adding pan to the agent's image lightbox: dragging a zoomed image far enough that the pointer left the panel closed the overlay on release.

## Cause

A `click` fires on the nearest common ancestor of where the pointer went down and where it came up.
Press inside the panel, release over the backdrop, and the click's target is the backdrop container itself - indistinguishable, to an `onClick` handler, from a deliberate click outside.

`e.target === e.currentTarget` does not save you: it is true in exactly this case.
Neither does `stopPropagation` on the panel, since the click was never dispatched on the panel to begin with.

This bites any gesture that can end outside the panel: dragging a zoomed image, selecting text to past the edge, dragging a slider thumb.

## Fix

Record where the press landed, and require the click to match it (`src/renderer/src/components/Overlay.tsx`):

```tsx
const pressedBackdrop = useRef(false);
…
onPointerDown={(e) => { pressedBackdrop.current = e.target === e.currentTarget; }}
onClick={(e) => {
  if (closeOnBackdrop && pressedBackdrop.current && e.target === e.currentTarget) onClose();
}}
```

## Takeaway

Dismiss on a *gesture* that began outside, not on a click that happened to end there.
Any close-on-outside handler wants the pointerdown target as well as the click target.
