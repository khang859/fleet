# Linux title bar overlay is one opaque block

## What happened

On Linux the main window used Electron's `titleBarOverlay` with a fixed `color: '#090a0d'`.
With a background image behind the app, the window controls sat on a solid dark rectangle in the top-right corner.
The overlay was 36px tall while the renderer's drag strip is 24px, so the rectangle also covered the rounded top-right corner of the card below.

## What we learned

`titleBarOverlay` only takes three options: one background `color` behind all three buttons, a `symbolColor`, and a `height`.
A fully transparent color (`#00000000`) does work on Linux, but the buttons, their hover states and their shape still cannot be styled, so they cannot match the app chrome.

## Fix

On Linux the window drops `titleBarOverlay` and the renderer draws its own minimize / maximize / close pill (`WindowControls.tsx`), driven over IPC.
`drawsOwnWindowControls` in `src/shared/window-controls.ts` is the one place that decides which platforms do this.
Windows keeps the native overlay, because hovering its maximize button opens the snap layouts flyout, which a button drawn in the page cannot offer.

## Verifying

GNOME on Wayland refuses screenshots from outside the shell, and `fleet-drive screenshot` only captures the page, so native window controls never show up in it.
Ask the user for an OS screenshot when the question is about native window chrome.
