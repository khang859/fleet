# Git Changes Modal — Design Spec

**Date:** 2026-03-16
**Status:** Approved
**Approach:** @git-diff-view/react + Shiki (Approach A)

## Overview

A read-only modal that displays current git working changes (staged + unstaged) for the focused terminal pane's working directory. Triggered via keyboard shortcut or pane toolbar button.

## Trigger

- **Keyboard:** `Cmd+G` (Mac) / `Ctrl+Shift+G` (other) — added to `src/renderer/src/lib/shortcuts.ts`
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
- **Dismissal:** `Escape`, `q`, click scrim, or X button

## File List Sidebar (Left Panel)

- **Filter input** at top — filter-as-you-type with count display ("3 of 12 files")
- **File entries:**
  - Status icon/color: green (added), yellow (modified), red (deleted), blue (renamed)
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
- **Syntax highlighting theme:** VS Code dark theme (e.g., `github-dark`) — single default, configurable later
- **Large diffs:** Virtual scrolling built into `@git-diff-view/react`
- **Search:** `Cmd+F` / `Ctrl+F` opens scoped search bar at top of diff pane with match count and next/prev

## Keyboard Navigation

**Global (modal open):**
| Key | Action |
|-----|--------|
| `Escape` / `q` | Close modal |
| `Cmd+F` / `Ctrl+F` | Search in diff |
| `Tab` | Toggle focus between file list and diff pane |
| `/` | Focus file filter input |

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

Focus is trapped within the modal. Initial focus goes to the file list.

## IPC & Data Flow

### Main Process

**New module: `src/main/git-service.ts`**
- Uses `simple-git` library
- Checks if CWD is inside a git repo (`git rev-parse --is-inside-work-tree`)
- Runs `git status` (parsed file list) and `git diff HEAD` (unified diff string including staged changes)
- Returns structured payload:

```typescript
interface GitStatusPayload {
  isRepo: boolean
  branch: string
  files: Array<{
    path: string
    status: 'added' | 'modified' | 'deleted' | 'renamed'
    insertions: number
    deletions: number
  }>
  diff: string // raw unified diff
}
```

### IPC Channel

- `GIT_STATUS` — added to `src/shared/constants.ts`, handler in `src/main/ipc-handlers.ts`
- Request: `{ cwd: string }`
- Response: `GitStatusPayload`

### Preload Bridge

Added to `src/preload/index.ts`:
```typescript
git: {
  getStatus: (cwd: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd)
}
```

### Renderer Flow

1. User triggers `Cmd+G` → dispatches `fleet:toggle-git-changes`
2. `GitChangesModal` component opens, reads focused pane's CWD from `cwd-store`
3. Calls `window.api.git.getStatus(cwd)` on mount
4. If `isRepo` is false → shows "Not a git repository" message
5. If `isRepo` is true → passes `diff` to `@git-diff-view/react`, `files` to sidebar

### Pane Toolbar

Git icon button in `PaneToolbar`:
- Queries repo status on pane focus (lightweight `isRepo` check via IPC)
- Hidden when pane CWD is not inside a git repo
- Click dispatches `fleet:toggle-git-changes`

## Dependencies (New)

| Package | Purpose |
|---------|---------|
| `simple-git` | Git operations from main process |
| `@git-diff-view/react` | Diff parsing + rendering |
| `@git-diff-view/shiki` | Syntax highlighting integration |
| `shiki` | TextMate-based syntax highlighting engine |

## Files to Create/Modify

**New files:**
- `src/main/git-service.ts` — git operations module
- `src/renderer/src/components/GitChangesModal.tsx` — modal component

**Modified files:**
- `src/shared/constants.ts` — add `GIT_STATUS` IPC channel
- `src/shared/types.ts` — add `GitStatusPayload` type
- `src/preload/index.ts` — add `git.getStatus` bridge
- `src/main/ipc-handlers.ts` — register git status handler
- `src/renderer/src/lib/shortcuts.ts` — add `Cmd+G` shortcut
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
