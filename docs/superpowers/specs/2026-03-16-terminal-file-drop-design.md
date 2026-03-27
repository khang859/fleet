# Terminal File Drag-and-Drop

**Date:** 2026-03-16
**Status:** Approved

## Problem

Users running CLIs like Claude Code in Fleet's terminal panes need to provide file paths as input. Currently they must type or paste paths manually. Dragging files from Finder/Explorer directly into the terminal pane should insert the file path as text input.

## Design

### Approach

React event handlers on `TerminalPane.tsx` — no new files, hooks, or xterm.js addons. The outer wrapper div receives drag events, formats file paths, and writes them to the PTY via the existing `window.fleet.pty.input()` IPC channel.

### Event Handling

Add four handlers to the `TerminalPane` wrapper div:

- **`onDragOver`** — `e.preventDefault()`, set `e.dataTransfer.dropEffect = 'copy'`
- **`onDragEnter`** — `e.preventDefault()`, increment a ref counter, set `isDragOver = true`
- **`onDragLeave`** — Decrement counter, set `isDragOver = false` when counter reaches 0
- **`onDrop`** — `e.preventDefault()`, `e.stopPropagation()`, read files, format paths, write to PTY, re-focus terminal, reset drag state

A `useRef<number>(0)` counter handles the DOM's dragenter/dragleave bubbling through child elements, preventing overlay flicker.

`e.preventDefault()` on drop is critical — without it, Electron/Chromium navigates to the dropped file. `e.stopPropagation()` prevents the event from bubbling to parent split-pane containers.

### Path Resolution

Electron v39 (our version) removed `file.path`. File paths must be resolved via `webUtils.getPathForFile(file)` from the `electron` module, exposed through the preload bridge under a `utils` namespace:

```typescript
// preload/index.ts
import { webUtils } from 'electron';

// Add to fleetApi object:
utils: {
  getFilePath: (file: File) => webUtils.getPathForFile(file);
}
```

`contextBridge` unwraps `File` objects passed from the renderer, so `webUtils.getPathForFile` receives the original File and returns the native path string.

### Path Formatting

For each dropped file (including directories — treated identically):

1. Resolve the native path via `window.fleet.utils.getFilePath(file)`
2. Quote the path using platform-appropriate shell rules:
   - **macOS/Linux**: Use single quotes. Escape internal single quotes as `'\''`. Single-quoting prevents all shell expansion (`$`, `!`, backticks, etc.)
   - **Windows**: Use double quotes. Escape internal double quotes as `\"`.
3. Join multiple paths with a single space separator
4. Append a trailing space after the last path (so the user can immediately type the next argument)
5. Write the resulting string to PTY via `window.fleet.pty.input({ paneId, data: formattedPaths })`

Platform detection: use `process.platform` exposed via preload (already available as we're in Electron).

Examples (macOS/Linux):

- Clean path: `'/usr/bin/node' `
- Path with spaces: `'/Users/me/My Documents/file.txt' `
- Path with single quote: `'/Users/me/it'\''s a file.txt' `
- Multiple files: `'/path/to file.txt' '/path/clean.js' `

### Visual Feedback

When `isDragOver` is true, render an overlay inside the terminal pane wrapper:

- Absolute positioned, fills the pane
- Semi-transparent background: `bg-blue-500/10`
- Dashed border: `border-2 border-dashed border-blue-400`
- Centered text: "Drop to paste file path"
- `pointer-events-none` so it doesn't interfere with the drop target on the parent

The overlay appears on drag enter and disappears on drop or drag leave. No animation beyond the state toggle.

### Post-Drop Behavior

After writing the paths to the PTY, call `term.focus()` to ensure the terminal retains focus so the user can immediately press Enter or continue typing.

### Edge Cases

- **Non-file drags** (text, URLs): Ignored — only process when `e.dataTransfer.files.length > 0`
- **Directory drops**: Treated the same as files — the directory path is inserted
- **Drag cancel / leave window**: Counter decrements back to 0, overlay hides. As a safety net, reset `isDragOver` to false on document-level `drop` events to prevent a stuck overlay.
- **Accessibility**: Users can already type or paste file paths manually, satisfying WCAG 2.5.7's non-drag alternative requirement

### Files Modified

1. **`src/renderer/src/components/TerminalPane.tsx`** — Drag event handlers, overlay UI, state management, post-drop focus
2. **`src/preload/index.ts`** — Expose `utils.getFilePath` via `webUtils.getPathForFile`, expose `platform`
3. **`src/renderer/src/env.d.ts`** (or equivalent type file) — Update `FleetApi` type to include `utils` namespace

No new files created.

## References

- [Electron: webUtils.getPathForFile](https://www.electronjs.org/docs/latest/api/web-utils#webutilsgetpathforfilefile) — required replacement for removed `file.path`
- [NNG: Drag-and-Drop UX](https://www.nngroup.com/articles/drag-drop/) — visual feedback patterns, usability heuristics
- [WCAG 2.5.7: Dragging Movements](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) — accessibility requirement for non-drag alternative
