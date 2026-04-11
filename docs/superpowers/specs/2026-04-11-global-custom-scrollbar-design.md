# Global Custom Scrollbar Design

## Problem

Fleet uses native Chromium scrollbars which are thick, gray, and visually jarring against the dark terminal-focused UI. An unused `.scrollbar-sc` class exists in `index.css` but is not applied anywhere.

## Research

- **NNG** ([Scrolling and Scrollbars](https://www.nngroup.com/articles/scrolling-and-scrollbars/)): Scrollbars should be visible when content is scrollable, use contrasting thumb against the trough, and look recognizably like scrollbars. Very thin bars increase interaction cost (steering law).
- **Baymard** ([Avoid Inline Scroll Areas](https://baymard.com/blog/inline-scroll-areas)): Hidden/disappearing scrollbars cause users to miss content ("illusion of completeness"). Persistent, visible scrollbars are recommended.

**Takeaway:** Don't hide scrollbars. Keep them recognizable. Styling them thinner and on-brand is fine as long as contrast and visibility are maintained.

## Decision

**Approach A: Universal webkit pseudo-elements.** Apply `*::-webkit-scrollbar` styles globally in `index.css`. Every scrollable element gets the custom scrollbar automatically with no per-component class needed. Cross-browser concerns are irrelevant since Fleet runs on Chromium (Electron).

## Spec

| Property | Value | Rationale |
|---|---|---|
| Thumb width | `6px` | Subtle but grabbable (VS Code uses ~7px) |
| Thumb color | `#2dd4bf33` (cyan 20% opacity) | On-brand accent, doesn't compete with content |
| Thumb hover | `#2dd4bf66` (cyan 40% opacity) | Visible feedback on interaction |
| Thumb border-radius | `3px` | Soft pill shape |
| Track background | `transparent` | Invisible track, thumb floats cleanly |
| Visibility | Always visible when content overflows | Per Baymard/NNG recommendation |

## Changes

### `src/renderer/src/index.css`

- **Remove** the unused `.scrollbar-sc` class (lines 55-68)
- **Add** universal scrollbar rules:
  - `*::-webkit-scrollbar` — width: 6px
  - `*::-webkit-scrollbar-track` — background: transparent
  - `*::-webkit-scrollbar-thumb` — background: #2dd4bf33, border-radius: 3px
  - `*::-webkit-scrollbar-thumb:hover` — background: #2dd4bf66

### No other files change

- All `overflow-y-auto` / `overflow-auto` classes on components remain untouched
- Terminal scrolling (xterm.js) is unaffected — it manages its own scrollbar internally
