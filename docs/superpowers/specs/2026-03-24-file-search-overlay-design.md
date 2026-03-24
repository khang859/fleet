# File Search Overlay — Design Spec

## Problem

Finding specific files (e.g. screenshots in a folder) via the existing File Browser Drawer is slow. The tree-based browsing and workspace-scoped search don't support system-wide file discovery. Users need a fast way to find any file on disk and paste its path into the active terminal.

## Solution

A Spotlight-style overlay (`FileSearchOverlay`) that uses OS-level search to find files across the entire filesystem and pastes the selected file's path into the active terminal pane.

## Research Basis

Baymard Institute and Nielsen Norman Group research both recommend:
- Supporting both search and browse (this overlay covers search-dominant users; existing drawer covers browse)
- Recency/frequency weighting in results
- Fuzzy matching with highlighted match characters
- Showing parent path context alongside filenames
- Capping visible results at ~8-10 with keyboard navigation
- Zero-state with recent items on empty query

---

## Section 1: Search Backend

### IPC Handler

New IPC channel: `fleet:file-search`

**Request:** `{ query: string, scope?: string, limit?: number }`
- `query` — the search string (filename or fragment)
- `scope` — optional absolute path to restrict search (e.g. `~/Desktop`)
- `limit` — max results, default 20

**Response:** Union type matching existing codebase conventions:
```ts
type FileSearchResult = {
  path: string;
  name: string;
  parentDir: string;
  modifiedAt: number; // epoch ms
  size: number;       // bytes
};

type FileSearchResponse =
  | { success: true; results: FileSearchResult[] }
  | { success: false; error: string };
```

**Populating metadata:** OS search tools (`mdfind`, `locate`, `find`) return paths only. After collecting paths, the backend calls `fs.stat()` on each result to populate `modifiedAt` and `size`. This adds minimal latency for 20 results.

### Platform-Specific Search

**macOS:** `mdfind` (Spotlight CLI). Supports `-onlyin` for scoping, `kMDItemDisplayName` for filename matching. Instant results from Spotlight index.

**Windows:** `Everything` CLI (`es.exe`) if available. Fallback: `powershell Get-ChildItem -Recurse -Filter` scoped to the user's home directory (not entire filesystem) with 5s timeout. If no scope is set, restrict fallback to `$HOME` to avoid unbounded searches.

**Linux:** `locate` if available, fallback to `find` scoped to user's home directory with 5s timeout. Same home-directory restriction as Windows fallback.

All backends: results capped at `limit`, sorted by modification date descending.

### Debouncing & Cancellation

Renderer debounces search input at 150ms before sending IPC request.

**Cancellation:** The main process stores a reference to the active `ChildProcess` spawned by the search. When a new search request arrives, it kills the previous process (`SIGTERM`) before spawning a new one. Each request includes a `requestId` (incrementing counter) so the renderer can discard stale responses that arrive after a newer request was sent.

### Timeouts

Fallback search commands (`Get-ChildItem`, `find`) have a **5-second timeout**. When the timeout fires, the process is killed and partial results collected so far are returned. If no results were collected, the response is `{ success: false, error: "Search timed out" }`. Indexed search tools (`mdfind`, `es.exe`, `locate`) do not need a timeout as they return near-instantly.

### Recent Files Tracking

An LRU list (max 20 entries) of files previously pasted via the overlay, persisted to `localStorage` under key `fleet:file-search-recent`. Shown as zero-state when overlay opens with empty query.

Note: `localStorage` is per-renderer and won't sync across multiple windows. This is acceptable for v1 — recent files are a convenience, not critical state.

---

## Section 2: UI — The Overlay

### Component

New component: `FileSearchOverlay` in `src/renderer/src/components/FileSearchOverlay.tsx`

### Trigger

- Keyboard shortcut: `Cmd+Shift+O` (macOS) / `Ctrl+Shift+O` (Windows/Linux)
- Pane toolbar: new search icon button
- Command palette: "Search Files on Disk" entry

### Layout

Centered modal overlay, same visual style as `QuickOpenOverlay`:
- Search input at top with scope indicator pill ("Everywhere" or scoped path)
- Results list below (max 10 visible, scrollable)
- Footer with keyboard hints (`↑↓ navigate`, `↵ paste`, `⇥ scope to folder`, `esc dismiss`)

### Result Row

Each row displays:
- File type icon (reuse `getFileIcon`)
- Filename (bold, fuzzy-match characters highlighted client-side using the same `HighlightedText` pattern from `QuickOpenOverlay`)
- Parent directory path (muted, truncated from left if long)
- Modified date (muted, relative format — "2m ago", "yesterday")

### Zero-State (Empty Query)

Shows recently pasted files from LRU history with header "Recent".

### Interactions

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate results |
| `Enter` | Paste selected file path into active pane, dismiss |
| `Tab` | Scope search to selected result's parent folder |
| `Escape` | Dismiss overlay |
| Click | Same as Enter for clicked row |

Single-select only. The existing `FileBrowserDrawer` handles multi-select use cases.

### Loading & Empty States

- **Loading:** While a search is in-flight, show a subtle "Searching..." indicator below the input.
- **No results:** Show "No files found" with the current scope context.
- **Error:** Show the error message from the backend (e.g. "Search timed out") in muted red text.
- **No active pane:** Disable Enter key, show "No active terminal" hint in footer (same pattern as `FileBrowserDrawer`'s disabled Done button).

### Deduplication

Results are deduplicated by resolved absolute path before returning to the renderer. This handles symlinks and duplicate Spotlight metadata entries.

### Scoping

Scope is a **separate state variable**, never parsed from the query string. The query input is always purely a filename search.

- Default scope: "Everywhere" (no `-onlyin` restriction, or home directory for non-indexed fallbacks).
- `Tab` on a selected result sets scope to that result's parent folder. The scope pill updates and the query input is preserved.
- Clicking the scope pill opens a small dropdown: "Everywhere", "Home", or a folder picker to set a custom scope.
- `Backspace` on an empty query clears the scope back to "Everywhere".

This avoids ambiguity between path prefixes and filename queries.

---

## Section 3: Integration & Paste Behavior

### Paste Mechanics

On selection, the file's absolute path is shell-quoted via `quotePathForShell()` and sent to the active pane via `pty.input({ paneId, data })`. If no pane is active, show a brief toast: "Focus a terminal first".

### Shortcut Registration

Add `file-search` entry to `shortcuts.ts`:
- macOS: `Cmd+Shift+O`
- Windows/Linux: `Ctrl+Shift+O`

### Command Palette

Add "Search Files on Disk" to `commands.ts` so the overlay is discoverable via `Cmd+K`.

### Pane Toolbar

Add a search/magnifying-glass icon button to `PaneToolbar.tsx` next to the existing folder (file browser) button. Folder icon continues to open the drawer; new icon opens the search overlay.

### Coexistence with Existing UI

| Component | Purpose | Stays? |
|-----------|---------|--------|
| `FileBrowserDrawer` | Tree browsing, multi-select, paste paths | Yes, unchanged |
| `QuickOpenOverlay` | Workspace-scoped file opening (editor) | Yes, unchanged |
| `FileSearchOverlay` | System-wide find-and-paste single file | New |

No changes to existing components beyond wiring the new shortcut and toolbar button.

---

## Files to Create/Modify

### New Files
- `src/renderer/src/components/FileSearchOverlay.tsx` — the overlay component
- `src/main/file-search.ts` — platform-specific search backend + IPC handler

### Modified Files
- `src/shared/ipc-channels.ts` — add `fleet:file-search` channel
- `src/shared/ipc-api.ts` — add type definitions
- `src/preload/index.ts` — expose `fileSearch` API
- `src/main/ipc-handlers.ts` — register the new handler
- `src/renderer/src/lib/shortcuts.ts` — add `file-search` shortcut
- `src/renderer/src/lib/commands.ts` — add command palette entry
- `src/renderer/src/components/PaneToolbar.tsx` — add search button
- `src/renderer/src/App.tsx` — mount overlay, wire shortcut
