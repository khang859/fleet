# xterm.js fitAddon.fit() can reset viewport to line 0

## Problem

When Claude Code CLI was streaming output and the user switched to another OS window then came back, the terminal viewport would jump to line 0 (top of scrollback) instead of staying at the bottom where output was happening.

## Root Cause

Two related issues:

1. **OS window switch:** `fitPreservingScroll()` trusted `fitAddon.fit()` to keep the viewport at bottom when `wasAtBottom` was true. But `fit()` can reset the viewport to line 0 when the terminal rendered offscreen.

2. **Tab switch (display:none):** xterm.js doesn't keep the viewport pinned to bottom when the terminal's container has `display: none`. New content advances `baseY` but `viewportY` stays put. When the tab becomes visible again, `ResizeObserver` fires and `fitPreservingScroll` sees `viewportY < baseY`, incorrectly concluding the user scrolled up.

## Fix

Track scroll intent explicitly with a `pinnedToBottom` boolean instead of checking the instantaneous `viewportY >= baseY`. The pinned state is:
- `true` initially
- Set to `false` when user scrolls up (detected via wheel events)
- Set to `true` when user scrolls to bottom, types input, or clicks "scroll to bottom"

`fitPreservingScroll` uses this tracked state:

```ts
if (!savedPinned) {
  term.scrollToLine(Math.min(savedViewportY, buf.baseY));
} else {
  term.scrollToBottom(); // Don't trust fit() to stay at bottom
}
```

**Key insight:** Never infer user intent from xterm buffer state alone — it's unreliable when the terminal is hidden.

## Related: xterm.js onScroll doesn't fire for trackpad/mouse wheel

`term.onScroll` fires when the buffer scrolls (new content), not when the viewport moves via user input. To detect user-initiated scrolling, also listen for `wheel` events on the container with a `requestAnimationFrame` delay so xterm has updated `buf.viewportY`.

## Related: Programmatic scrollToBottom doesn't fire onScroll

When calling `term.scrollToBottom()` programmatically, `onScroll` may not fire. If you're tracking scroll state (e.g., to show/hide a "scroll to bottom" button), manually notify after the programmatic scroll.

## Follow-up: onScroll race condition during fast output (same-pane jump to top)

Even with `pinnedToBottom` tracking, the viewport could randomly jump to the top while Claude Code was running in the **active, visible** pane. Root cause: `term.onScroll(() => updatePinnedState())` called `updatePinnedState` on every content-driven scroll event. During fast output, `baseY` advances before `viewportY` catches up, so `viewportY < baseY - 2` is briefly true, falsely flipping `pinnedToBottom = false`. If `fitPreservingScroll` fires at that moment (ResizeObserver, click), it restores position instead of following bottom, and `fit()` can reset viewport to 0.

**Fix:** `onScroll` must only **re-pin** (set `pinnedToBottom = true` when at bottom), never **unpin**. Only `wheel` events should unpin, since they represent actual user scroll intent. Additionally, `fitPreservingScroll` reconciles the flag before acting: if `pinnedToBottom` is false but `isAtBottom()` is true, correct it.

**Key insight:** `term.onScroll` only fires for content-driven scrolling (new lines added), never for user wheel/keyboard scrolling (confirmed by xterm.js issues #3864, #3201). It must never be used to infer user scroll-up intent. This is a known class of bug — Tabby terminal has the same issue with Claude Code (Tabby #10648).

## Follow-up: Viewport stale while Electron window is unfocused

Even with `pinnedToBottom` working correctly, the terminal viewport visually sat at an old scroll position while the OS window was unfocused and Claude Code was producing output. Clicking back into the window would jump to the bottom.

**Root cause:** xterm.js auto-scrolls the viewport via its rendering pipeline, which uses `requestAnimationFrame`. Chromium pauses rAF in unfocused windows. So `term.write(data)` processes data and advances `baseY`, but the viewport's DOM `scrollTop` is never updated to follow — it stays at the old absolute pixel value while content grows below it. Visually the terminal appears stuck near the top.

**Fix:** Use `term.write(data, callback)` instead of `term.write(data)`. In the callback (which fires after xterm has processed the data and updated the buffer), call `term.scrollToBottom()` if `pinnedToBottom` is true. This explicitly sets the DOM scroll position after each write, bypassing xterm's rAF-dependent auto-scroll.

**Key insight:** xterm.js's auto-scroll relies on rAF, which doesn't run in unfocused Chromium windows. Don't depend on it — explicitly scroll after writes when following live output. A `window.focus` handler is just a band-aid; the viewport should never drift in the first place.
