# Dashboard Empty State Design

**Date:** 2026-04-11
**Inspired by:** [dashboard-nvim](https://github.com/nvimdev/dashboard-nvim) (Doom theme)

## Overview

Replace the current minimal empty state ("No tabs open. Press Cmd+T to create one.") with a styled dashboard screen that appears when no tabs are open. Centered vertical layout with ASCII art branding, a quick action, and recent files/folders.

## Component Structure

### New file: `src/renderer/src/components/Dashboard.tsx`

A standalone React component rendered in place of the current empty-state `div` in `App.tsx` (line 763). Receives props from the workspace store and callbacks for actions.

**Props:**
- `recentFiles: string[]` — from workspace store (already exists)
- `recentFolders: string[]` — from workspace store (new)
- `onNewTerminal: () => void` — triggers `addTab()`
- `onOpenFile: (filePath: string) => void` — opens file in editor tab
- `onOpenFolder: (folderPath: string) => void` — opens folder as workspace

### Integration point: `App.tsx`

Replace the empty-state block at line 762-765:

```tsx
// Before
<div className="flex items-center justify-center h-full text-neutral-600">
  No tabs open. Press Cmd+T to create one.
</div>

// After
<Dashboard
  recentFiles={recentFiles}
  recentFolders={recentFolders}
  onNewTerminal={...}
  onOpenFile={...}
  onOpenFolder={...}
/>
```

## Data Layer — Recent Folders

Mirror the existing recent files pattern in `workspace-store.ts`:

- **localStorage key:** `fleet:recent-folders`
- **Max items:** 10
- **State field:** `recentFolders: string[]`
- **Action:** `addRecentFolder(folderPath: string)` — deduplicates, prepends, and caps at max
- **Helpers:** `loadRecentFolders()` / `saveRecentFolders()` — same pattern as `loadRecentFiles()` / `saveRecentFiles()`
- **Trigger:** called whenever a workspace is loaded/opened, using the workspace's `cwd`

## Visual Design

### Layout

Vertically and horizontally centered flexbox column (`items-center justify-center h-full`). Max-width capped to prevent stretching on wide screens. Generous vertical spacing (`gap`) between sections.

### ASCII Art Header

Block-letter "FLEET" rendered as a `<pre>` with each line as a separate styled `<span>`:

```
███████╗██╗     ███████╗███████╗████████╗
██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝
█████╗  ██║     █████╗  █████╗     ██║
██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║
██║     ███████╗███████╗███████╗   ██║
╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝
```

Top-to-bottom teal-to-cyan gradient applied per line:
- Lines 1-2: `text-teal-500`
- Lines 3-4: `text-cyan-500`
- Lines 5-6: `text-cyan-400`

Font: monospace (inherits app Nerd Font). Size: `text-sm`.

### Tagline

`terminal multiplexer for ai agents` — rendered in `text-neutral-600 text-xs`, below the ASCII art with spacing.

### New Terminal Action

Single clickable row:
- Terminal icon (lucide-react `Terminal`, 16px)
- "New Terminal" label
- `⌘T` keybinding badge (dimmer, `text-neutral-600`)

Styled: `text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer`. Clicking triggers `onNewTerminal`.

### Recent Folders Section

- Heading: `"Recent Folders"` in `text-neutral-600 text-xs uppercase tracking-wider`
- List of up to 10 folder paths, displayed shortened (replace `$HOME` with `~`)
- Each path: `text-neutral-400 hover:text-cyan-400 cursor-pointer`
- Clicking a folder calls `onOpenFolder(fullPath)`, which opens a new terminal tab with that folder as `cwd`
- If no recent folders, section is hidden

### Recent Files Section

- Heading: `"Recent Files"` in `text-neutral-600 text-xs uppercase tracking-wider`
- List of up to 10 file paths (from the existing 20 stored, display first 10)
- Each path: `text-neutral-400 hover:text-cyan-400 cursor-pointer`
- Clicking a file calls `onOpenFile(fullPath)`
- If no recent files, section is hidden

### Path Display

All paths are shortened for display:
- Replace home directory prefix with `~`
- Show full shortened path (e.g., `~/Dev/fleet/src/App.tsx`)

## Behavior

- Dashboard renders only when `activeTabId` is null (no tabs open)
- Dashboard disappears instantly when any tab is created/switched to
- Recent folders/files lists update reactively from the Zustand store
- Keyboard shortcut `⌘T` continues to work globally (existing behavior)
- No additional keyboard navigation needed for v1

## Files Modified

1. **`src/renderer/src/components/Dashboard.tsx`** — new component
2. **`src/renderer/src/store/workspace-store.ts`** — add `recentFolders` state, `addRecentFolder()`, load/save helpers
3. **`src/renderer/src/App.tsx`** — replace empty-state div with `<Dashboard />`
