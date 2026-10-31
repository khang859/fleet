# Escape in a popover also closed the Overlay around it

`Overlay` listens for Escape on `document`.
A Radix popover inside it also takes Escape, so one press closed both, and the dialog lost what was typed in it.

## The fix

Radix listens in the capture phase and calls `preventDefault()` when it dismisses a layer.
`Overlay` now skips an Escape with `defaultPrevented` set.
Components that handle Escape in an Overlay and call `preventDefault()` also call `onClose` themselves, so they still close.
