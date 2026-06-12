# Permission notification fires repeatedly (2026-06-12)

## Problem

When a Claude Code session showed a permission prompt, the OS notification "An
agent needs your permission" re-fired roughly every 500ms (and the chime played
continuously) instead of once per request.

## Root cause

Level-triggered detection that should have been edge-triggered.
`NotificationDetector.checkPermissionPrompt` ran its regexes against **every PTY
data chunk** (`ipc-handlers.ts` → `scan()`) and was **stateless**. Claude's Ink
TUI continuously repaints the prompt (spinner, cursor blink, countdown), so each
repaint chunk re-matched the trigger text and re-emitted a `notification`
event. Downstream consumers faithfully amplified the stream:

- OS popup coalescer (`index.ts`) only batches **within** a 500ms window, then
  resets its timer — a sustained stream yields one popup per window.
- Renderer chime (`use-notifications.ts`) plays per event.
- `ActivityTracker` churned `working ↔ needs_me` because `onData` reset state to
  `working` on every chunk, then the next emit re-promoted `needs_me`.

## Fix

Edge-trigger at the single source plus a clean resolution signal:

1. **Per-pane latch in `NotificationDetector`** — emit `permission` once, then
   suppress redraw re-emits. Re-arm only after the user types into the pane
   (`onUserInput`) **and** the trigger text stops reappearing within a short
   grace window (`PERMISSION_RESET_GRACE_MS = 400`). The grace + "matched since
   input" flag is what distinguishes a genuine answer (prompt gone → re-arm)
   from arrow-key navigation (prompt repaints → stay latched, no re-ping).
2. **`ActivityTracker.onData` no longer demotes `needs_me`** — a blocked agent's
   own redraw output must not clear the blocked state. Only `onUserInput`
   (new) or `onExit` resolves it.
3. **Wire `PTY_INPUT`** to call `notificationDetector.onUserInput` and
   `activityTracker.onUserInput` before writing.

Reset signal choice: user input (not time-decay, not Enter-only). Time-decay
suppresses Claude's common rapid tool-after-tool prompts; Enter-only misses
number-key selections (`1`/`2`/`3`) that submit without a carriage return.

## Lesson

Anything that scans a continuous output stream for a state ("needs permission",
"idle", "done") must be **edge-triggered** — emit on the transition, not on every
matching chunk. Hold per-source state and define an explicit re-arm signal.
Downstream coalescers/dedup (the 500ms OS batch, `setState` dedup) only mask
bursts; they cannot fix a level-triggered source feeding a sustained stream.
