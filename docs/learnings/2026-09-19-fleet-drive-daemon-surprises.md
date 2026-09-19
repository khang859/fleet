# fleet-drive daemon: five things that did not work as planned

Found while building the warm drive daemon (`docs/fleet-drive-daemon-plan.md`).

## `document.visibilityState` never says a dev window is minimized

The plan was to replace the sharp blank-screenshot check with a check of `document.visibilityState` before capture.
Electron's docs say that with `backgroundThrottling: false`, which dev sets, the page always reports `visible`, even when minimized.
The fix was to keep the sharp check, and make it cheap instead (see the next item).

## sharp `stats()` ignores the pipeline

`sharp(img).resize(64, 64).stats()` returns the stats of the full-size input, not of the resized image.
`stats()` reads its input, so the resize never runs.
Materialize the shrink first (`.raw().toBuffer()`), then call `stats()` on a new `sharp` of that buffer.
The check went from about 70 ms to about 11 ms.

## Two animation frames is not "the UI has settled"

`--shot` first waited two `requestAnimationFrame`s before its screenshot.
Settings mounts a lazy panel a moment after the click, so the capture showed the empty frame before it.
It now waits until the DOM has had no mutation for 100 ms (at most 2 s), then two frames.

## Refs race closing animations

A ref from `snapshot --refs` pointed at a palette row while the palette was closing.
The click waited out the full 5 s timeout, then clicked something else as the layout moved, and split a pane.
A ref names an element that already exists, so there is nothing to wait for: refs now get a 1 s timeout, and a ref with no element fails at once with "take a new snapshot".

## The dev app inherits the driving agent's environment

`drive up` started `npm run dev` with the agent's own environment, and every pane inherited it.
Claude Code started in a pane then saw `CLAUDE_CODE_CHILD_SESSION` and other `CLAUDE_*` markers, and showed "Transcript saving is off - inherited CLAUDE_CODE_CHILD_SESSION marker".
The pane was not testing what a user sees.
`startDevApp` now removes `CLAUDECODE` and every `CLAUDE_*` variable before it spawns the app.

## Lesson

Before designing around a platform behavior, check the docs for the mode the app actually runs in.
When a test harness launches the app, check what it passes down: a harness run by an agent carries that agent's state.
