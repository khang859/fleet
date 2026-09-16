# A hot reload leaves the old terminal link provider running

While verifying bare-filename terminal links end to end, a refactor that kept every unit test green looked completely broken in the app: every filename that had been a link a minute earlier came back `plain`.

Nothing was broken.
The renderer had hot-reloaded `use-terminal.ts`, but the xterm instance in the pane is created once and kept in a module-level registry, and its `registerLinkProvider` registration still pointed at the provider built by the *previous* module instance.
The pane was running old code while the bundle on disk was new.

`npm run drive -- keys 'Meta+r'` and a re-test showed the refactor working correctly.

**The rule:** anything registered on a long-lived xterm instance - link providers, decorations, custom key handlers - survives HMR and keeps the code it was registered with.
Reload the window before concluding a terminal change does not work, and treat "it worked, then the same check failed after an edit" as a stale-registration symptom first.

## A second trap in the same session

Reading `el.className` in the same tick as the dispatched `mousemove` always reports what the *previous* hover left behind.
xterm resolves a link asynchronously (the provider awaits a `stat` or a directory read), so `xterm-cursor-pointer` lands several hundred milliseconds later.

This is worse than a plain race, because it produces a confident wrong answer in both directions: it reported `LINK` for a cell that had no link, because the pointer had been over a real one before.
Wait ~500ms after the move, then read.
