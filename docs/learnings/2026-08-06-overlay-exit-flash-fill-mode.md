# An overlay that flashes on the way out is missing `fill-mode: forwards`

Reported as "a weird flash/stutter when I exit the lightbox by clicking outside of it".
It happens on any overlay built on `Overlay` / `usePresence`, but you only notice it where the panel is large - a full-screen image, not a 200px menu.

## Cause

`Overlay` keeps the tree mounted for `overlayExitMs` after `open` goes false so the exit animation has time to run.
The animation itself comes from tw-animate-css (`data-[state=closed]:animate-out fade-out-0 zoom-out-95`), whose `--animate-out` is defined with `var(--tw-animation-fill-mode, none)` - **`fill-mode: none` unless you say otherwise**.

With `fill-mode: none`, the moment the animation finishes the element reverts to its own styles: full opacity, full scale.
It then sits there, fully visible, until the timer fires and React unmounts it - at minimum one render plus one paint, and more under load.
That single visible frame at 100% opacity, right after a fade to 0, is the flash.

## Fix

Hold the last frame. In `src/renderer/src/lib/motion.ts`:

```diff
 export const overlayTiming =
-  'ease-[…] data-[state=open]:duration-150 data-[state=closed]:duration-100';
+  'ease-[…] data-[state=open]:duration-150 data-[state=closed]:duration-100 data-[state=closed]:fill-mode-forwards';
```

Everything composed from `overlayTiming` (`popperAnim`, `dialogFadeAnim`, `Overlay` itself) picks it up.

## How to see it

The state is readable, so you do not have to trust your eyes on a 100ms event:

```
npm run drive -- eval "(() => { const c = document.querySelector('.fixed.inset-0.z-50'); return JSON.stringify({ state: c.dataset.state, fill: getComputedStyle(c).animationFillMode }) })()"
```

During a close it must report `{"state":"closed","fill":"forwards"}`.
Before the fix it reported `"none"`.

## Takeaway

Any exit animation whose element is unmounted by a timer needs `fill-mode-forwards`.
The animation finishing and the element disappearing are two different events, and nothing guarantees they are in the same frame - so the end state has to be sticky, not merely reached.
Radix's own Presence has the same shape, so the rule holds for `popperAnim`-style classes too.
