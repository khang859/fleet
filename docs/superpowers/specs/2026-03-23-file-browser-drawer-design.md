# File Browser Drawer — Design Spec

**Date:** 2026-03-23
**Status:** Approved (v2 — post-review fixes)

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

// Response — matches existing { success, error } convention
{
  success: boolean
  error?: string        // present when success is false
  entries: {
    name: string
    path: string        // absolute path
    isDirectory: boolean
  }[]
}
```

Entries are sorted: directories first, then files, both alphabetically. On permission error, return `{ success: false, error: 'Permission denied', entries: [] }`.

### New Component: `FileBrowserDrawer`

- Rendered at the bottom of `App.tsx` alongside `SettingsModal`, `QuickOpenOverlay`, etc.
- Controlled by `fileBrowserOpen: boolean` state in `App.tsx`.
- Opened/closed via `fleet:toggle-file-browser` custom DOM event (consistent with all other panels).

### New Utility: `src/renderer/src/lib/shell-utils.ts`

Extract `quotePathForShell` from `use-terminal-drop.ts` into a shared utility file and export it. Update `use-terminal-drop.ts` to import from there. `FileBrowserDrawer` imports from the same utility.

```ts
export function quotePathForShell(filePath: string, platform: string): string;
```

### State (owned by `FileBrowserDrawer`)

| State             | Type          | Description                                                                                                                                                                                                              |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rootDir`         | `string`      | Current root. Defaults to `window.fleet.homeDir` (with `''` guard — see Edge Cases). Persisted to `localStorage` as `fleet:file-browser-root`. On first load with no stored value, falls back to `window.fleet.homeDir`. |
| `nodes`           | `TreeNode[]`  | Top-level tree nodes. Reset when root changes.                                                                                                                                                                           |
| `selectedPaths`   | `Set<string>` | Absolute paths of selected files.                                                                                                                                                                                        |
| `query`           | `string`      | Search input value. When non-empty, switches to flat fuzzy mode.                                                                                                                                                         |
| `searchFiles`     | `FileEntry[]` | Full flat file list loaded once on first keystroke (files only — no directories). Filtered client-side via `fuzzyMatch`.                                                                                                 |
| `isSearchLoading` | `boolean`     | True while `file.list` is in-flight.                                                                                                                                                                                     |

### TreeNode Shape

```ts
type TreeNode = {
  name: string;
  path: string; // absolute path
  isDirectory: boolean;
  children: TreeNode[] | null; // null = not yet loaded; [] = loaded, empty
  isExpanded: boolean;
};
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
│   └── Non-empty → FlatList mode (fuzzy results, files only)
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

- When the user types, the view switches to a flat fuzzy list showing **files only** (search uses `file.list` which returns files, not directories).
- `file.list(rootDir)` is called **once** on the first non-empty keystroke and the result is cached in `searchFiles` for the lifetime of the drawer session. Subsequent keystrokes filter client-side via the existing `fuzzyMatch` utility from `lib/commands`.
- Clearing the input returns to the tree (preserving expand state and `searchFiles` cache).

### Changing Root

- Clicking the root dir label in the header opens the native folder picker via `window.fleet.showFolderPicker()`.
- On selection: update `rootDir`, persist to `localStorage`, reset tree nodes, selection, and `searchFiles` cache.

### Pasting Paths ("Done")

1. Collect all paths from `selectedPaths`.
2. Apply `quotePathForShell(path, window.fleet.platform)` to each (from `lib/shell-utils.ts`).
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

- **Mac:** `Cmd+Shift+E` — free in current `ALL_SHORTCUTS` list, consistent with VS Code Explorer convention
- **Non-Mac:** `Ctrl+Shift+E` — free in current `ALL_SHORTCUTS` list

Registered by adding an entry to `ALL_SHORTCUTS` in `src/renderer/src/lib/shortcuts.ts`:

```ts
{
  id: 'file-browser',
  label: 'Browse files',
  mac: { key: 'E', meta: true, shift: true },
  other: { key: 'E', ctrl: true, shift: true }
}
```

Handled in `src/renderer/src/hooks/use-pane-navigation.ts` alongside all other shortcut handlers — dispatches `fleet:toggle-file-browser`.

> **Linux note:** `Ctrl+Shift+E` is the fcitx/ibus IME toggle on some Linux setups and may be silently consumed by the OS before Electron sees it. Users affected can rebind via settings. If this proves widespread in practice, migrate the non-Mac binding to `Ctrl+Shift+B`.

### Toolbar Button

- Added to `PaneToolbar` via a new **optional** callback prop: `onFileBrowser?: () => void`.
- Threaded from `App.tsx` → `PaneGrid` → `TerminalPane` → `PaneToolbar`, same pattern as `onGitChanges`.
- Icon: `FolderOpen` from Lucide.
- Tooltip: `Browse files (⌘⇧E)` / `Browse files (Ctrl+Shift+E)`.
- Calls `onFileBrowser()`, which in the parent dispatches `fleet:toggle-file-browser`.

### Command Palette

- Register in `src/renderer/src/lib/commands.ts` → `createCommandRegistry()` so the action appears when searching the palette.

---

## Error Handling & Edge Cases

| Scenario                                          | Behavior                                                                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Empty directory                                   | "This folder is empty" placeholder under the node                                                                                                                                                                  |
| `FILE_READDIR` fails (`success: false`)           | Inline error under the folder node: "Can't read folder" — rest of tree unaffected                                                                                                                                  |
| Search returns no results                         | "No matching files" message                                                                                                                                                                                        |
| `file.list` fails/slow in search mode             | Loading indicator while in-flight; "Couldn't load file list" on failure                                                                                                                                            |
| Active pane is not a terminal (e.g. file tab)     | "Done" disabled, note: "Focus a terminal to paste"                                                                                                                                                                 |
| `window.fleet.homeDir` is `''` (HOME not set)     | Fall back to active pane CWD, then `/`. Two-step lookup: `const paneId = useWorkspaceStore.getState().activePaneId; const cwd = useCwdStore.getState().cwds.get(paneId ?? '') ?? '/'` — synchronous, no IPC needed |
| `localStorage` has no stored root on first launch | Use `window.fleet.homeDir` (with `''` guard above)                                                                                                                                                                 |
| Drawer open during terminal resize                | No impact — drawer is `position: fixed` overlay, zero effect on PTY layout                                                                                                                                         |

---

## Files to Create / Modify

### Create

- `src/renderer/src/components/FileBrowserDrawer.tsx` — main drawer component
- `src/renderer/src/lib/shell-utils.ts` — extract and export `quotePathForShell`

### Modify

- `src/main/ipc-handlers.ts` — add `FILE_READDIR` handler
- `src/shared/constants.ts` — add `FILE_READDIR` IPC channel constant
- `src/shared/ipc-api.ts` — add `DirEntry` type and `ReaddirResponse` type
- `src/preload/index.ts` — expose `window.fleet.file.readdir(dirPath): Promise<ReaddirResponse>`
- `src/renderer/src/App.tsx` — add `fileBrowserOpen` state, event listener, render `<FileBrowserDrawer>`
- `src/renderer/src/components/PaneToolbar.tsx` — add `onFileBrowser?: () => void` prop + button
- `src/renderer/src/components/PaneGrid.tsx` — thread `onFileBrowser` down to `TerminalPane`
- `src/renderer/src/components/TerminalPane.tsx` — thread `onFileBrowser` down to `PaneToolbar`
- `src/renderer/src/lib/shortcuts.ts` — add `file-browser` entry to `ALL_SHORTCUTS`
- `src/renderer/src/hooks/use-pane-navigation.ts` — handle `file-browser` shortcut, dispatch event
- `src/renderer/src/lib/commands.ts` — add `file-browser` command to palette registry
- `src/renderer/src/hooks/use-terminal-drop.ts` — import `quotePathForShell` from `lib/shell-utils.ts`
