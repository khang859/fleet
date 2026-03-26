# Terminal Goes Blank After Closing Sibling Pane

## What happened

When Claude Code was running in a split pane and the sibling pane was closed, the Claude Code screen went blank. The content only returned when the user typed a command (triggering a TUI redraw).

## Root cause

When a pane is closed, `removePaneFromTree` collapses the split node — the tree goes from `split{leafA, leafB}` to just `leafA`. React's recursive `PaneNodeRenderer` returns different element types for splits (`<div className="flex">`) vs leaves (`<TerminalPane>`). Since the element type at the same React tree position changed, React **unmounted the old subtree and mounted a new one**.

This destroyed the xterm.js Terminal instance, including its **alternate screen buffer** (where Claude Code renders its TUI). The PTY kept running in the main process, but the new xterm instance started with an empty buffer. A SIGWINCH-triggered redraw should have restored it, but timing issues between the debounced resize, the `attach()` round-trip, and the `attachResolved` gate prevented reliable recovery.

## Fix

Refactored `PaneGrid` to use a **portal-based rendering architecture** that separates layout structure from terminal lifecycle:

1. **LayoutNode** (recursive): renders the flex containers, resize handles, and empty `<div>` slots for leaves — handles the visual layout
2. **TerminalPanes** (flat siblings): rendered at a stable position in the React tree with `key={leaf.id}`, then portaled into their layout slots via `createPortal`

Because the TerminalPanes are keyed siblings at the same React tree level, they **never unmount** when the tree structure changes. When a split collapses, only the layout containers change — the terminal component stays mounted with its xterm.js instance (and alt-screen buffer) intact.

## Key lesson

In React, component lifecycle is determined by position in the **React tree** (element type + key at each level), not the DOM tree. Recursive renderers that change element types at the same position will unmount/remount children. For components with important internal state (like terminal emulators with buffers), render them at a stable React tree position and use portals to place them in the correct DOM location.
