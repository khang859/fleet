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
