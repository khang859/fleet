# File Browser Drawer — Design Spec

**Date:** 2026-03-23
**Status:** Approved

## Overview

A right-side overlay drawer that lets users browse the filesystem, select one or more files, and paste their absolute paths directly into the active terminal. Solves the friction of drag-and-drop or context-switching to find a file path.

---

## UX Research Notes

- **NNGroup right-rail blindness:** Right-side panels are ignored on ad-heavy web pages, but in tool-focused apps (IDEs, terminals) they are contextually expected. Mitigation: keep the design minimal and clean.
- **Side drawer best practice (Designmonks/NNGroup):** Right-side overlay drawers are the correct pattern for "supportive tools that don't require constant interaction." Overlay (not push) avoids terminal resize events. Escape key + clear close button are required.
- Keyboard shortcut is essential for discoverability alongside the toolbar button — a toolbar button alone is too easy to miss.

---

## Architecture

### New IPC Channel: `FILE_READDIR`

Added to `ipc-handlers.ts`. Returns the immediate children of a directory — no recursion.

```ts
// Request
{ dirPath: string }

// Response
{ entries: { name: string; path: string; isDirectory: boolean }[] }
```

Entries are sorted: directories first, then files, both alphabetically. Permission errors return `{ entries: [] }` with an error flag.

### New Component: `FileBrowserDrawer`

- Rendered at the bottom of `App.tsx` alongside `SettingsModal`, `QuickOpenOverlay`, etc.
- Controlled by `fileBrowserOpen: boolean` state in `App.tsx`.
- Opened/closed via `fleet:toggle-file-browser` custom DOM event (consistent with all other panels).

### State (owned by `FileBrowserDrawer`)

| State | Type | Description |
|---|---|---|
| `rootDir` | `string` | Current root. Defaults to `window.fleet.homeDir`. Persisted to `localStorage` as `fleet:file-browser-root`. |
| `nodes` | `TreeNode[]` | Top-level tree nodes. Reset when root changes. |
| `selectedPaths` | `Set<string>` | Absolute paths of selected files. |
| `query` | `string` | Search input value. When non-empty, switches to flat fuzzy mode. |
| `searchResults` | `FileEntry[]` | Results from `file.list(rootDir)` filtered by query. |
| `isSearchLoading` | `boolean` | Loading indicator for search mode. |

### TreeNode Shape

```ts
type TreeNode = {
  name: string
  path: string           // absolute path
  isDirectory: boolean
  children: TreeNode[] | null  // null = not yet loaded; [] = loaded, empty
  isExpanded: boolean
}
```

Children are `null` until the user expands the folder. `FILE_READDIR` is called on first expand only — already-loaded folders do not re-fetch.

---

## Component Structure

```
FileBrowserDrawer
├── Header
│   ├── Title: "Browse Files"
│   ├── Root dir label (truncated, clickable → opens native folder picker)
│   └── Close button (×)
├── Search input
│   ├── Empty → TreeView mode
│   └── Non-empty → FlatList mode (fuzzy results)
├── Content (scrollable)
│   ├── TreeView (default)
│   │   └── TreeNode (recursive, lazy children)
│   └── FlatList (search active)
│       └── File rows with fuzzy-highlighted names
└── Footer
    ├── Selection count ("3 files selected")
    ├── Clear button
    └── Done button (disabled when nothing selected or no active PTY)
```

---

## Interactions

### Tree Navigation
- Clicking a **directory row** expands/collapses it. On first expand, calls `FILE_READDIR` and populates children.
- Clicking a **file row** toggles it in/out of the selection `Set`. Visual indicator: highlight + subtle checkbox.
- Directories are not selectable.

### Search Mode
- When the user types in the search input, the view switches to a flat fuzzy list.
- Calls the existing `file.list(rootDir)` IPC (which uses `git ls-files` or recursive walk).
- Results filtered with the existing `fuzzyMatch` utility from `lib/commands`.
- Clearing the input returns to the tree (preserving expand state).

### Changing Root
- Clicking the root dir label in the header opens the native folder picker via `window.fleet.showFolderPicker()`.
- On selection: update `rootDir`, persist to `localStorage`, reset tree nodes and selection.

### Pasting Paths ("Done")
1. Collect all paths from `selectedPaths`.
2. Apply `quotePathForShell(path, window.fleet.platform)` to each (reuse logic from `use-terminal-drop.ts`).
3. Join with a single space, append a trailing space.
4. Call `window.fleet.pty.input({ paneId: activePaneId, data })`.
5. Close the drawer.

`activePaneId` is read from `useWorkspaceStore.getState().activePaneId`.

### Keyboard
- `Escape` closes the drawer.
- `Tab` / `Shift+Tab` navigates between interactive elements.
- `Enter` on a file row toggles selection.
- `Enter` on a directory row expands/collapses.

---

## Triggers

### Keyboard Shortcut
- `Cmd+Shift+F` (Mac) / `Ctrl+Shift+F` (Windows/Linux)
- Registered in the existing keybindings/shortcuts system.
- Dispatches `fleet:toggle-file-browser`.

### Toolbar Button
- Added to `PaneToolbar` (right side, alongside existing split/close buttons).
- Icon: folder-open or similar from Lucide.
- Tooltip: "Browse files (⌘⇧F)".
- Dispatches `fleet:toggle-file-browser`.

---

## Error Handling & Edge Cases

| Scenario | Behavior |
|---|---|
| Empty directory | "This folder is empty" placeholder under the node |
| `FILE_READDIR` fails (permission denied, deleted) | Inline error under the folder node: "Can't read folder" — rest of tree unaffected |
| Search returns no results | "No matching files" message |
| `file.list` fails/slow in search mode | Loading indicator while waiting; "Couldn't load file list" on failure |
| Active pane is not a terminal (e.g. file tab) | "Done" disabled, note: "Focus a terminal to paste" |
| Home dir doesn't exist | Fall back to active pane CWD, then `/` |
| Drawer open during terminal resize | No impact — drawer is `position: fixed` overlay, zero effect on PTY layout |

---

## Files to Create / Modify

### Create
- `src/renderer/src/components/FileBrowserDrawer.tsx` — main drawer component

### Modify
- `src/main/ipc-handlers.ts` — add `FILE_READDIR` handler
- `src/shared/constants.ts` — add `FILE_READDIR` IPC channel constant
- `src/shared/ipc-api.ts` — add `FileDirEntry` type and request/response types
- `src/preload/index.ts` — expose `window.fleet.file.readdir(dirPath)`
- `src/renderer/src/App.tsx` — add `fileBrowserOpen` state, event listener, render `<FileBrowserDrawer>`
- `src/renderer/src/components/PaneToolbar.tsx` — add folder-browse icon button
- `src/renderer/src/components/ShortcutsHint.tsx` (or keybindings) — register `Cmd+Shift+F`
