# Telescope Picker Design

A multi-mode fuzzy finder modal for Fleet, inspired by telescope.nvim and OS file explorers. Provides a unified interface for finding files, searching content, browsing directories, and switching panes.

## Requirements

- Four switchable modes: Files, Grep, Browse, Panes
- Two-column layout: results list (left) + preview panel (right)
- Context-dependent select action per mode
- Coexists with existing overlays (QuickOpenOverlay, FileSearchOverlay) — does not replace them
- New keyboard shortcut + pane toolbar button
- Cross-platform (macOS, Linux, Windows)

## Architecture: Modal Shell + Pluggable Modes

A thin `TelescopeModal` shell owns the layout and delegates to mode modules via a shared interface. Each mode is a separate file implementing `TelescopeMode`.

### File Structure

```
src/renderer/src/components/Telescope/
  TelescopeModal.tsx          — modal shell: layout, mode tabs, keyboard nav, preview column
  types.ts                    — TelescopeMode interface, TelescopeItem type
  modes/
    files-mode.ts             — fuzzy file search in cwd
    grep-mode.ts              — content search via FILE_GREP IPC
    browse-mode.ts            — directory navigation with breadcrumbs
    panes-mode.ts             — open pane listing from workspace store

src/main/file-grep.ts          — rg/grep/findstr backend
```

### Modified Files

```
src/shared/ipc-channels.ts     — add FILE_GREP channel constant
src/shared/ipc-api.ts          — add FileGrepRequest/Response/Result types
src/preload/index.ts            — add window.fleet.file.grep()
src/main/ipc-handlers.ts       — register FILE_GREP handler
src/renderer/src/App.tsx        — add telescope state, render TelescopeModal, wire event
src/renderer/src/components/PaneToolbar.tsx — add Telescope button
src/renderer/src/components/TerminalPane.tsx — pass onTelescope to PaneToolbar
src/shared/shortcuts.ts         — add telescope shortcut definition
```

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  search input                                mode tabs  │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│   Results list           │   Preview panel              │
│   (keyboard navigable)   │   (file content / pane info) │
│                          │                              │
│   > item 1 (selected)    │   1  import React from ...   │
│     item 2               │   2  import { useState }...  │
│     item 3               │   3                          │
│                          │                              │
├──────────────────────────┴──────────────────────────────┤
│  ↑↓ navigate  ↵ open  ⇧↵ paste path  esc dismiss       │
└─────────────────────────────────────────────────────────┘
```

- Width: ~800px (wider than existing 560px overlays for preview column)
- Height: max 70vh, positioned at 10vh from top
- Results column: ~40% width, scrollable
- Preview column: ~60% width, scrollable, monospace font, line numbers
- Backdrop: `bg-black/60` click-to-dismiss (same as existing overlays)

## Mode Interface

```typescript
type TelescopeItem = {
  id: string;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  meta?: string;
};

type TelescopeMode = {
  id: string;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  onSearch: (query: string) => Promise<TelescopeItem[]> | TelescopeItem[];
  renderPreview: (item: TelescopeItem) => ReactNode;
  onSelect: (item: TelescopeItem) => void;
  onAltSelect?: (item: TelescopeItem) => void;
};
```

## Mode Behaviors

### Files (`Cmd+1`)

- Searches via `window.fleet.file.list(cwd)` + client-side fuzzy match
- Empty query shows recent files from workspace store
- Preview: file contents via `window.fleet.file.read()`
- Enter: open file in viewer pane
- Shift+Enter: paste path into terminal

### Grep (`Cmd+2`)

- New IPC channel `FILE_GREP` — runs `rg` / `grep -rn` / `findstr` in the pane's cwd
- Debounced search (300ms)
- Each result: filename, line number, matching line text
- Preview: file contents scrolled to matching line with highlight
- Enter: open file in viewer at that line
- Shift+Enter: paste `file:line` into terminal

### Browse (`Cmd+3`)

- Uses `window.fleet.file.readdir()` for current directory
- Query acts as filter on current directory listing (not fuzzy search across tree)
- Directories listed first, then files
- Breadcrumb trail for navigation; clicking a segment jumps back up
- Backspace on empty query navigates up one directory
- Preview: file contents for files, directory listing for folders
- Enter on file: open in viewer. Enter on directory: drill in.
- Shift+Enter: paste path

### Panes (`Cmd+4`)

- Reads PaneLeaf nodes from workspace store layout tree
- Shows: pane label (or shell name), cwd, pane type
- Fuzzy search on label + cwd
- Preview: pane info (label, shell, cwd, type)
- Enter: focus that pane (setActivePane + fleet:refocus-pane)

## IPC: FILE_GREP Channel

```typescript
// Request
type FileGrepRequest = {
  requestId: number;
  query: string;
  cwd: string;
  limit?: number;        // default 50
};

// Response
type FileGrepResponse = {
  success: boolean;
  requestId: number;
  results: FileGrepResult[];
  error?: string;
};

type FileGrepResult = {
  file: string;          // absolute path
  relativePath: string;  // relative to cwd
  line: number;          // 1-based line number
  text: string;          // the matching line content
  contextBefore?: string[];
  contextAfter?: string[];
};
```

### Cross-Platform Strategy

| Platform | Primary | Fallback |
|----------|---------|----------|
| All      | `rg` (ripgrep) | `grep -rn` (macOS/Linux) or `findstr` (Windows) |

Implementation follows the same pattern as `src/main/file-search.ts`: try primary tool, catch ENOENT, spawn fallback. Results normalized to the same shape regardless of tool.

## Keyboard Shortcuts

### Opening

- `Cmd+Shift+T` (macOS) / `Ctrl+Shift+T` (Windows/Linux)
- Pane toolbar button (Telescope icon from lucide-react)

### Inside the Modal

| Key | Action |
|-----|--------|
| `Cmd+1` / `Ctrl+1` | Files mode |
| `Cmd+2` / `Ctrl+2` | Grep mode |
| `Cmd+3` / `Ctrl+3` | Browse mode |
| `Cmd+4` / `Ctrl+4` | Panes mode |
| `↑` / `↓` | Move selection |
| `Enter` | Primary action (context-dependent) |
| `Shift+Enter` | Paste path into terminal |
| `Escape` | Close modal |
| `Backspace` (empty query, Browse) | Navigate up one directory |

### Event Wiring

Custom event `fleet:toggle-telescope` dispatched from shortcut handler, caught in App.tsx. Toolbar button's onTelescope callback dispatches the same event.

## Data Flow

1. User presses `Cmd+Shift+T` or clicks toolbar button
2. `fleet:toggle-telescope` event fires, App.tsx sets `telescopeOpen: true`, passes `focusedPaneCwd`
3. TelescopeModal renders, defaults to Files mode
4. User types — modal delegates to active mode's `onSearch(query)`
5. Mode returns results — modal renders in left column
6. Arrow keys change selection — modal calls `renderPreview(selectedItem)` for right column
7. Enter — modal calls `onSelect(item)`, mode performs action
8. Modal closes, dispatches `fleet:refocus-pane`

Preview content fetched on selection change with ~100ms debounce. Loading indicator shown if read takes >200ms.
