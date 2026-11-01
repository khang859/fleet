# Agent panes redraw every row, and scrollToBottom is not why

Date: 2026-11-01

Issue 716 blamed `term.scrollToBottom()` for full-pane redraws on each write.
That is true for a plain shell.
It is not the main cause in Claude Code 2.1.316 or pi 1.4.0.

## What was measured

Rows rebuilt in a 38-row pane, counted with a `MutationObserver` on `.xterm-rows`:

| Case                    | Old code      | With `followBottom` |
| ----------------------- | ------------- | ------------------- |
| Shell, one-row spinner  | 40 rows/write | 5.7 rows/write      |
| Shell, scrolling output | 73 rows/write | 73 rows/write       |
| Claude Code, spinner    | 391 rows/s    | 375 rows/s          |
| pi, spinner             | 464 rows/s    | 459 rows/s          |

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

## What the leftover costs

A fake spinner with Claude Code's byte shape gives 384 rows/s in a 38-row pane, and the real agent gives 391.
Measured in one visible dev pane with `LOG_LEVEL=info`, after a restart for each mode:

| Mode                        | Renderer main thread | Whole app, GPU included |
| --------------------------- | -------------------- | ----------------------- |
| Idle                        | 2.6%                 | 8-9%                    |
| DOM renderer                | 6.1-6.5%             | 15-17%                  |
| DOM, unchanged rows skipped | 5.2%                 | 14%                     |
| WebGL addon 0.19.0          | 2.4%                 | 10%                     |

Skipping unchanged rows cut rebuilt rows by 35 times, but it saved only about a quarter of the spinner's cost.
So row count is a poor stand-in for CPU, and a row-skip patch on private xterm fields is not worth it.
WebGL removes the DOM style and layout work.

## Traps in this measurement

`Meta+r` through `npm run drive -- keys` does not reload the window.
Restart the app between modes, or a patch from the last mode stays active.

`__FLEET__.terminals` also holds hidden panes from restored tabs.
Pick the term with `t.element?.offsetParent`, not the first entry.

Discard whole-app samples just after a restart, because boot work and process exits skew them.

## 8-pane result and more bench traps

With 8 panes, the first set showed a 63% whole-app gain for WebGL.
Repeat runs showed that this number was too high.
The real whole-app gain is about 35% to 55%, and `docs/terminal-webgl-pool-plan.md` has the tables.

`addTab` returns the new pane id, not the tab id.

A saved layout comes back after a restart, so a bench that adds splits will pile up panes.
Assert the visible pane count before sampling, or the numbers look fine and mean nothing.

Installing a different xterm with `--no-save` does not refresh Vite's cache, so delete `node_modules/.vite`.

## Do not trust one set of whole-app CPU

Two DOM runs that agreed within 5% made the whole-app number look safe, and it was not.
Over 12 runs, DOM whole-app CPU moved from 26% to 60% with the same load.
The cause was not found, but the swing is mostly in renderer threads other than the main thread.

Always split CPU per process, and run each mode at least 3 times, in turn.
The split also showed that WebGL moves some cost to the GPU process, which the whole-machine GPU counter hid.
That counter is not safe either, because other apps on the machine change it.

More frames were not the main cost.
A shared paint tick cut frames by more than half at 100 ms, and it saved only about 10% of the main thread cost.

## Check the whole setup before a bench

The dev sandbox had a background picture on, so all 8-pane runs used transparent panes.
Check the theme and the background before a bench, and test the look on both.

WebGL moves work to WindowServer on macOS.
On solid panes, app CPU fell 31%, WindowServer rose by the same amount, and total CPU did not change.
Count WindowServer in any compositor change, and measure it on a quiet machine.

## The fix that shipped

A shared 250 ms paint tick for unfocused panes cut spinner cost by 49% in the app and 53% with WindowServer counted.
It beat WebGL on total CPU, and it works on picture backgrounds, where WebGL draws black boxes on styled text.
Do not judge a fix by one metric.
The tick looked weak on the main thread, and the whole picture came only from the per-process split with WindowServer.

Compare focus delays with the same load in both modes.
A first check with no output running made a long task look new, and a fair run showed it in both modes.

## Clearing a background deletes its file

Setting `terminalBackground.imagePath` to null prunes the image file at once, through `pruneBackgroundStore`.
A bench that did this deleted the picture from its dev sandbox, and the backup ran too late.
Set `stashedImagePath` in the same update, or copy the file first.
