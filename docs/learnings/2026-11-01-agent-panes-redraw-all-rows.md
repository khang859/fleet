# Agent panes redraw every row, and scrollToBottom is not why

Date: 2026-11-01

Issue 716 blamed `term.scrollToBottom()` for full-pane redraws on each write.
That is true for a plain shell.
It is not the main cause in Claude Code 2.1.316 or pi 1.4.0.

## What was measured

Rows rebuilt in a 38-row pane, counted with a `MutationObserver` on `.xterm-rows`:

| Case | Old code | With `followBottom` |
| --- | --- | --- |
| Shell, one-row spinner | 40 rows/write | 5.7 rows/write |
| Shell, scrolling output | 73 rows/write | 73 rows/write |
| Claude Code, spinner | 391 rows/s | 375 rows/s |
| pi, spinner | 464 rows/s | 459 rows/s |

## Why the agents did not improve

xterm requests the full range for two other reasons, and `followBottom` touches neither.

**Claude Code moves the cursor across the whole screen.**
A spinner frame starts with `CSI H` and ends with `CSI 38;1H` and `CSI 35;3H`.
`DirtyRowTracker` keeps one range, from the lowest row to the highest row the cursor visited.
So one changed row becomes a refresh of rows 0 to 37.

**pi uses synchronized output.**
Each frame ends with `CSI ?2026l`, and `InputHandler` then fires `onRequestRefreshRows(undefined)`, which means all rows.

The DOM renderer then rebuilds each row in the range, even when its content did not change.

## How to measure this

Wrap `term._core._renderService.refreshRows` and `term.write` from `npm run drive -- eval`.
The refresh ranges and the raw bytes together name the cause in one run.

Measure a spinner, not a streaming reply.
A long reply scrolls the agent's own view, so every row really does change and the cost hides.
Fill the screen first too, because a blank row produces no mutation and lowers the count.

## Testing scroll in an agent pane

Both agents run in the alternate screen with mouse tracking on, so `baseY` and `viewportY` stay 0.
Wheel events go to the agent, and the agent owns scrolling and its "Jump to bottom" banner.
Fleet's scroll button and `pinnedToBottom` do not apply there, so check the banner text instead of the buffer position.

One real wheel event moves only about 3 rows in a shell pane, whatever the delta.
A single large event cannot reach the bottom during live output, so send many small ones.

`scrollToBottom` with a distance of 0 cannot move the view, because the viewport adds 0 to its own position.
So skipping that call removes a redraw and nothing else.
