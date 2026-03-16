# Git Changes Modal — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Approach:** @git-diff-view/react + Shiki (Approach A)

## Overview

A read-only modal that displays current git working changes (staged + unstaged + untracked) for the focused terminal pane's working directory. Triggered via keyboard shortcut or pane toolbar button.

## Trigger

- **Keyboard:** `Cmd+Shift+G` (Mac) / `Ctrl+Shift+G` (other) — added to `src/renderer/src/lib/shortcuts.ts`
  - Concrete `ShortcutDef`: `{ id: 'git-changes', label: 'Git Changes', mac: { key: 'g', meta: true, shift: true }, other: { key: 'G', ctrl: true, shift: true } }`
  - Note: `Cmd+G` (without Shift) conflicts with system "Find Next" — avoided intentionally
- **Click:** Git icon button in `PaneToolbar` — only visible when the pane's CWD is inside a git repo
- Both dispatch `fleet:toggle-git-changes` custom DOM event

## Modal Shell & Layout

- **Near-full-screen overlay** (~90-95% viewport) with `bg-black/60` scrim backdrop
- Consistent with existing Fleet modal pattern (fixed overlay, click-scrim-to-close, `stopPropagation` on content)
- **Two-panel master-detail layout:**
  - Left panel (~240px, resizable): file list sidebar
  - Right panel (remaining space): full diff content
- **Header bar** across the top:
  - Branch name or "Working Changes" label
  - Summary stats: e.g., `12 files changed, +145 −32`
  - Unified/Split diff view toggle
  - Close button (X)
- **Dismissal:** `Escape`, `q` (only when no text input is focused), click scrim, or X button

## States

- **Loading:** Centered spinner with "Loading changes..." text while `git.getStatus()` is in flight
- **Error:** If `simple-git` fails (git not installed, corrupted repo, permission error), show error message in modal body with the error detail and a close button
- **Empty:** If repo has no changes, show "No changes" message centered in the modal
- **Not a repo:** If CWD is not inside a git repo, show "Not a git repository" message
- **No CWD:** If the focused pane's CWD is not yet known (OSC 7 / polling hasn't fired), show "Working directory not available" message

## File List Sidebar (Left Panel)

- **Filter input** at top — filter-as-you-type with count display ("3 of 12 files")
- **File entries:**
  - Status icon/color: green (added/untracked), yellow (modified), red (deleted), blue (renamed)
  - Filename (bold) with directory path below in muted text
  - Per-file change stats: `+14 −3`
  - Active file highlighted with subtle background
- **Layout:** Flat list sorted by file path (no directory tree nesting)
- **Behavior:**
  - Click a file → scroll diff pane to that file
  - Auto-highlight current file as user scrolls the diff pane
  - Sidebar scrolls independently from diff pane

## Diff Content Area (Right Panel)

- **Renderer:** `@git-diff-view/react` with `@git-diff-view/shiki` for syntax highlighting
- **Default view:** Unified diff (toggle to split/side-by-side via header button)
- **Per-file blocks:**
  - Sticky file header (filename + stats pinned while scrolling through hunks)
  - Collapse/expand per file via header click
  - Line numbers on both sides (old/new)
  - Addition lines: muted green background (`rgba(35, 134, 54, 0.15)`)
  - Deletion lines: muted red background (`rgba(218, 54, 51, 0.15)`)
  - Changed characters highlighted with brighter inline markers
- **Syntax highlighting:** Shiki with a custom bundle containing only commonly-used languages and the `github-dark` theme. Loaded lazily on first modal open (not at app startup) to avoid impacting initial load.
- **Large diffs:** Virtual scrolling built into `@git-diff-view/react`
- **Search:** `Cmd+F` / `Ctrl+F` opens scoped search bar at top of diff pane with match count and next/prev. The modal's `onKeyDown` handler intercepts `Cmd+F` via `stopPropagation` before it reaches the global shortcut handler (which binds `Cmd+F` to pane search).

## Keyboard Navigation

**Global (modal open):**
| Key | Action |
|-----|--------|
| `Escape` | Close modal |
| `q` | Close modal (only when no text input is focused) |
| `Cmd+F` / `Ctrl+F` | Search in diff (intercepted at modal level) |
| `Tab` | Toggle focus between file list and diff pane |
| `/` | Focus file filter input (only when no text input is focused) |

**File list focused:**
| Key | Action |
|-----|--------|
| `j` / `k` or `Up` / `Down` | Navigate files |
| `Enter` | Jump to that file's diff |

**Diff pane focused:**
| Key | Action |
|-----|--------|
| `n` / `p` | Jump to next/previous file |
| `Up` / `Down` | Scroll |
| `[` / `]` | Jump to next/previous hunk |

Focus is trapped within the modal. Initial focus goes to the file list. Single-key shortcuts (`q`, `/`, `j`, `k`, `n`, `p`, `[`, `]`) are disabled when a text input (filter or search) is focused.

## IPC & Data Flow

### Main Process

**New module: `src/main/git-service.ts`**
- Uses `simple-git` library
- Two functions:
  - `checkIsRepo(cwd: string)` — lightweight check via `git rev-parse --is-inside-work-tree` (used by pane toolbar)
  - `getFullStatus(cwd: string)` — runs `git status` (parsed) + `git diff HEAD` (tracked files) + individual `git diff --no-index /dev/null <file>` for each untracked file to generate diffs for new files
- Returns structured payload (or error):

```typescript
interface GitStatusPayload {
  isRepo: boolean
  branch: string
  files: Array<{
    path: string
    status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'
    insertions: number
    deletions: number
  }>
  diff: string // raw unified diff (all files combined)
  error?: string // set if git operation failed
}
```

### IPC Channels

Added to `src/shared/constants.ts`:
- `GIT_IS_REPO` — lightweight invoke, returns `{ isRepo: boolean }` for toolbar visibility
- `GIT_STATUS` — full invoke, returns `GitStatusPayload`

Handlers registered in `src/main/ipc-handlers.ts`.

### Preload Bridge

Added to `src/preload/index.ts`:
```typescript
git: {
  isRepo: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_IS_REPO, cwd),
  getStatus: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd)
}
```

### Renderer Flow

1. User triggers `Cmd+Shift+G` → dispatches `fleet:toggle-git-changes`
2. `GitChangesModal` component opens, reads focused pane's CWD from `cwd-store`
3. If CWD is undefined → shows "Working directory not available" state
4. Calls `window.fleet.git.getStatus(cwd)` on mount (shows loading spinner)
5. If `error` is set → shows error state
6. If `isRepo` is false → shows "Not a git repository" state
7. If `files` is empty → shows "No changes" state
8. Otherwise → passes `diff` to `@git-diff-view/react`, `files` to sidebar

### Pane Toolbar

Git icon button in `PaneToolbar`:
- Calls `window.fleet.git.isRepo(cwd)` on pane focus via the lightweight `GIT_IS_REPO` channel
- Hidden when CWD is undefined or not inside a git repo
- Click dispatches `fleet:toggle-git-changes`

## Dependencies (New)

| Package | Purpose |
|---------|---------|
| `simple-git` | Git operations from main process |
| `@git-diff-view/react` | Diff parsing + rendering |
| `@git-diff-view/shiki` | Syntax highlighting integration |
| `shiki` | TextMate-based syntax highlighting engine (lazy-loaded, custom bundle with common languages + `github-dark` theme) |

## Files to Create/Modify

**New files:**
- `src/main/git-service.ts` — git operations module
- `src/renderer/src/components/GitChangesModal.tsx` — modal component

**Modified files:**
- `src/shared/constants.ts` — add `GIT_IS_REPO` and `GIT_STATUS` IPC channels
- `src/shared/ipc-api.ts` — add `GitStatusPayload` type (consistent with existing IPC type location)
- `src/preload/index.ts` — add `git.isRepo` and `git.getStatus` bridge methods
- `src/main/ipc-handlers.ts` — register git IPC handlers
- `src/renderer/src/lib/shortcuts.ts` — add `Cmd+Shift+G` shortcut
- `src/renderer/src/hooks/use-pane-navigation.ts` — handle `fleet:toggle-git-changes` event
- `src/renderer/src/components/PaneToolbar.tsx` — add git icon button
- `src/renderer/src/App.tsx` — mount `GitChangesModal`

## UX Research References

- **Modal sizing:** Near-full-screen for content-heavy overlays (Baymard, NNG)
- **Dark theme:** Dark gray bg (not pure black), off-white text, muted diff tints, WCAG 4.5:1 contrast (NNG)
- **Navigation:** Master-detail with sticky headers, independent scroll regions (Baymard)
- **Keyboard-first:** Focus trapping, vim-style bindings for power users (NNG Heuristic #7)
- **Information density:** Never truncate silently, use visual hierarchy with color differentiation (Baymard)

## Future Considerations (Out of Scope)

- Staging/unstaging files from modal
- Discarding changes
- Committing from modal
- Directory tree grouping in file list
- Configurable syntax highlighting theme
- Auto-refresh on file system changes
