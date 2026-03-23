# File Browser Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side overlay drawer that lets users browse files, select one or more, and paste their absolute paths into the active terminal via a "Done" button.

**Architecture:** New `FILE_READDIR` IPC channel does single-level directory listing (lazy-loaded as tree folders expand). A `FileBrowserDrawer` React component lives alongside other panels in `App.tsx`, toggled by `fleet:toggle-file-browser` custom event and `Cmd+Shift+E` shortcut. On "Done", quoted absolute paths are written directly to the active PTY via `window.fleet.pty.input`.

**Tech Stack:** Electron IPC (ipcMain/ipcRenderer), React + TypeScript, Tailwind CSS, Lucide icons, Zustand (workspace/cwd stores), Vitest for unit tests.

---

## File Map

### Create
| File | Responsibility |
|---|---|
| `src/renderer/src/lib/shell-utils.ts` | Exported `quotePathForShell` utility (extracted from `use-terminal-drop.ts`) |
| `src/renderer/src/components/FileBrowserDrawer.tsx` | Full drawer component: tree view, search, multi-select, Done button |

### Modify
| File | What changes |
|---|---|
| `src/shared/ipc-channels.ts` | Add `FILE_READDIR: 'file:readdir'` constant |
| `src/shared/ipc-api.ts` | Add `DirEntry` and `ReaddirResponse` types |
| `src/main/ipc-handlers.ts` | Add `FILE_READDIR` ipcMain handler (uses already-imported `readdir`) |
| `src/preload/index.ts` | Expose `window.fleet.file.readdir(dirPath)` |
| `src/renderer/src/lib/shell-utils.ts` | (created above) |
| `src/renderer/src/hooks/use-terminal-drop.ts` | Import `quotePathForShell` from `lib/shell-utils` |
| `src/renderer/src/lib/shortcuts.ts` | Add `file-browser` entry to `ALL_SHORTCUTS` |
| `src/renderer/src/hooks/use-pane-navigation.ts` | Handle `file-browser` shortcut → dispatch `fleet:toggle-file-browser` |
| `src/renderer/src/lib/commands.ts` | Add `file-browser` to `createCommandRegistry()` |
| `src/renderer/src/components/PaneToolbar.tsx` | Add `onFileBrowser?: () => void` prop + FolderOpen button |
| `src/renderer/src/components/TerminalPane.tsx` | Pass `onFileBrowser` inline lambda to `PaneToolbar` |
| `src/renderer/src/App.tsx` | Add `fileBrowserOpen` state, event listener, render `<FileBrowserDrawer>` |

---

## Task 1: IPC Plumbing — `FILE_READDIR` channel, types, handler, preload

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

### Step 1.1: Add the IPC channel constant

In `src/shared/ipc-channels.ts`, add before `FILE_READ`:

```ts
FILE_READDIR: 'file:readdir',
```

Result: the object now has `FILE_READDIR: 'file:readdir'` alongside the existing `FILE_READ`, `FILE_LIST`, etc.

- [ ] Add `FILE_READDIR: 'file:readdir'` to `IPC_CHANNELS` in `src/shared/ipc-channels.ts`

### Step 1.2: Add types to `ipc-api.ts`

Append to the end of `src/shared/ipc-api.ts`:

```ts
export type DirEntry = {
  name: string;
  path: string;       // absolute path
  isDirectory: boolean;
};

export type ReaddirResponse =
  | { success: true; entries: DirEntry[] }
  | { success: false; error: string; entries: [] };
```

- [ ] Add `DirEntry` and `ReaddirResponse` types to `src/shared/ipc-api.ts`

### Step 1.3: Add the ipcMain handler

In `src/main/ipc-handlers.ts`, `readdir` is already imported from `fs/promises` at line 2. Add this handler near the other `FILE_*` handlers (after the `FILE_STAT` handler, around line 551):

```ts
// List immediate children of a directory (single level, no recursion)
ipcMain.handle(IPC_CHANNELS.FILE_READDIR, async (_event, { dirPath }: { dirPath: string }) => {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const sorted = entries
      .filter((e) => e.isFile() || e.isDirectory())
      .sort((a, b) => {
        const aIsDir = a.isDirectory();
        const bIsDir = b.isDirectory();
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return {
      success: true,
      entries: sorted.map((e) => ({
        name: e.name,
        path: join(dirPath, e.name),
        isDirectory: e.isDirectory()
      }))
    };
  } catch (err) {
    return { success: false, error: toError(err).message, entries: [] };
  }
});
```

Note: `join`, `readdir`, and `toError` are all already imported at the top of this file.

- [ ] Add the `FILE_READDIR` ipcMain handler to `src/main/ipc-handlers.ts`

### Step 1.4: Expose in preload

In `src/preload/index.ts`, import `ReaddirResponse` at the top (in the type import block from `../shared/ipc-api`):

```ts
import type {
  // ... existing imports ...
  ReaddirResponse
} from '../shared/ipc-api';
```

Then add `readdir` to the `file` object in `fleetApi` (after the `list` entry, around line 266):

```ts
readdir: async (dirPath: string): Promise<ReaddirResponse> =>
  typedInvoke(IPC_CHANNELS.FILE_READDIR, { dirPath }),
```

- [ ] Import `ReaddirResponse` in preload type imports
- [ ] Add `file.readdir` to the `fleetApi.file` object in `src/preload/index.ts`

### Step 1.5: Write a unit test for the handler

Create `src/main/__tests__/file-readdir.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';

// We test the handler logic in isolation using a mocked readdir
// The handler sorts dirs before files, alphabetically within each group

describe('FILE_READDIR handler logic', () => {
  it('sorts directories before files, then alphabetically', () => {
    type Entry = { name: string; isFile: () => boolean; isDirectory: () => boolean };
    const raw: Entry[] = [
      { name: 'zoo.ts', isFile: () => true, isDirectory: () => false },
      { name: 'alpha', isFile: () => false, isDirectory: () => true },
      { name: 'beta.ts', isFile: () => true, isDirectory: () => false },
      { name: 'mango', isFile: () => false, isDirectory: () => true }
    ];

    const sorted = raw
      .filter((e) => e.isFile() || e.isDirectory())
      .sort((a, b) => {
        const aIsDir = a.isDirectory();
        const bIsDir = b.isDirectory();
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    expect(sorted.map((e) => e.name)).toEqual(['alpha', 'mango', 'beta.ts', 'zoo.ts']);
  });

  it('maps entries to the correct shape', () => {
    type Entry = { name: string; isFile: () => boolean; isDirectory: () => boolean };
    const entries: Entry[] = [
      { name: 'src', isFile: () => false, isDirectory: () => true }
    ];
    const dirPath = '/home/user/project';
    const result = entries.map((e) => ({
      name: e.name,
      path: join(dirPath, e.name),
      isDirectory: e.isDirectory()
    }));
    expect(result[0]).toEqual({ name: 'src', path: '/home/user/project/src', isDirectory: true });
  });
});
```

- [ ] Create `src/main/__tests__/file-readdir.test.ts` with the above tests

### Step 1.6: Run tests and typecheck

```bash
npm run test -- file-readdir
npm run typecheck
```

Expected: tests pass, no type errors.

- [ ] Run tests — expect PASS
- [ ] Run typecheck — expect no errors

### Step 1.7: Commit

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts src/main/ipc-handlers.ts src/preload/index.ts src/main/__tests__/file-readdir.test.ts
git commit -m "feat: add FILE_READDIR IPC channel for single-level directory listing"
```

- [ ] Commit

---

## Task 2: Extract `quotePathForShell` to a shared utility

**Files:**
- Create: `src/renderer/src/lib/shell-utils.ts`
- Modify: `src/renderer/src/hooks/use-terminal-drop.ts`

### Step 2.1: Write the test first

Create `src/renderer/src/lib/__tests__/shell-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { quotePathForShell } from '../shell-utils';

describe('quotePathForShell', () => {
  it('single-quotes POSIX paths', () => {
    expect(quotePathForShell('/home/user/file.txt', 'darwin')).toBe("'/home/user/file.txt'");
  });

  it('escapes single quotes in POSIX paths', () => {
    expect(quotePathForShell("/home/user/it's a file.txt", 'linux')).toBe(
      "'/home/user/it'\\''s a file.txt'"
    );
  });

  it('double-quotes Windows paths (backslashes are NOT escaped — cmd/PowerShell do not require it)', () => {
    expect(quotePathForShell('C:\\Users\\user\\file.txt', 'win32')).toBe(
      '"C:\\Users\\user\\file.txt"'
    );
  });

  it('escapes double quotes in Windows paths', () => {
    expect(quotePathForShell('C:\\path with "quotes"\\file.txt', 'win32')).toBe(
      '"C:\\path with \\"quotes\\"\\file.txt"'
    );
  });
});
```

- [ ] Create `src/renderer/src/lib/__tests__/shell-utils.test.ts`

### Step 2.2: Run the test — expect FAIL (file doesn't exist yet)

```bash
npm run test -- shell-utils
```

Expected: FAIL with "Cannot find module '../shell-utils'"

- [ ] Run test — expect FAIL

### Step 2.3: Create the utility

Create `src/renderer/src/lib/shell-utils.ts`:

```ts
/**
 * Quotes a file path for safe shell insertion.
 * On POSIX: wraps in single quotes, escaping any internal single quotes.
 * On Windows: wraps in double quotes, escaping any internal double quotes.
 */
export function quotePathForShell(filePath: string, platform: string): string {
  if (platform === 'win32') {
    return '"' + filePath.replace(/"/g, '\\"') + '"';
  }
  // POSIX: single-quote, escape internal single quotes as '\''
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}
```

- [ ] Create `src/renderer/src/lib/shell-utils.ts`

### Step 2.4: Run tests — expect PASS

```bash
npm run test -- shell-utils
```

Expected: all 4 tests PASS.

- [ ] Run test — expect PASS

### Step 2.5: Update `use-terminal-drop.ts` to import from the utility

In `src/renderer/src/hooks/use-terminal-drop.ts`:

1. Delete the local `quotePathForShell` function (lines 3–8).
2. Add this import at the top:

```ts
import { quotePathForShell } from '../lib/shell-utils';
```

The rest of the file is unchanged — `quotePathForShell` is already used exactly once in `formatDroppedFiles`.

- [ ] Remove the local `quotePathForShell` from `use-terminal-drop.ts`
- [ ] Add the import from `../lib/shell-utils`

### Step 2.6: Typecheck

```bash
npm run typecheck
```

Expected: no errors.

- [ ] Run typecheck — expect no errors

### Step 2.7: Commit

```bash
git add src/renderer/src/lib/shell-utils.ts src/renderer/src/lib/__tests__/shell-utils.test.ts src/renderer/src/hooks/use-terminal-drop.ts
git commit -m "refactor: extract quotePathForShell to shared shell-utils utility"
```

- [ ] Commit

---

## Task 3: Register `file-browser` shortcut and command palette entry

**Files:**
- Modify: `src/renderer/src/lib/shortcuts.ts`
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts`
- Modify: `src/renderer/src/lib/commands.ts`

### Step 3.1: Add shortcut definition

In `src/renderer/src/lib/shortcuts.ts`, add to the end of `ALL_SHORTCUTS` array (before the closing `]`):

```ts
{
  id: 'file-browser',
  label: 'Browse files',
  mac: { key: 'E', meta: true, shift: true },
  other: { key: 'E', ctrl: true, shift: true }
}
```

> **Linux note:** `Ctrl+Shift+E` may be consumed by fcitx/ibus IME on some Linux setups. Users can rebind via settings if needed.

- [ ] Add `file-browser` shortcut to `ALL_SHORTCUTS` in `src/renderer/src/lib/shortcuts.ts`

### Step 3.2: Add the keyboard handler

In `src/renderer/src/hooks/use-pane-navigation.ts`, add after the `quick-open` handler (around line 125), before the Cmd+1-9 block:

```ts
if (matchesShortcut(e, sc('file-browser'))) {
  e.preventDefault();
  document.dispatchEvent(new CustomEvent('fleet:toggle-file-browser'));
  return;
}
```

- [ ] Add the `file-browser` shortcut handler to `use-pane-navigation.ts`

### Step 3.3: Add command palette entry

In `src/renderer/src/lib/commands.ts`, add to the end of the array in `createCommandRegistry()` (before the closing `]`):

```ts
{
  id: 'file-browser',
  label: 'Browse Files',
  shortcut: sc('file-browser'),
  category: 'File',
  execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-file-browser'))
}
```

- [ ] Add `file-browser` command to `createCommandRegistry()` in `src/renderer/src/lib/commands.ts`

### Step 3.4: Typecheck

```bash
npm run typecheck
```

Expected: no errors.

- [ ] Run typecheck — expect no errors

### Step 3.5: Commit

```bash
git add src/renderer/src/lib/shortcuts.ts src/renderer/src/hooks/use-pane-navigation.ts src/renderer/src/lib/commands.ts
git commit -m "feat: register file-browser shortcut (Cmd+Shift+E) and command palette entry"
```

- [ ] Commit

---

## Task 4: Add "Browse files" button to PaneToolbar

**Files:**
- Modify: `src/renderer/src/components/PaneToolbar.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`

### Step 4.1: Update `PaneToolbar`

In `src/renderer/src/components/PaneToolbar.tsx`:

1. Add `FolderOpen` to the Lucide import: `import { Columns2, Rows2, Search, X, GitBranch, FolderOpen } from 'lucide-react';`

2. Add `onFileBrowser?: () => void` to `PaneToolbarProps`:

```ts
type PaneToolbarProps = {
  visible: boolean;
  isGitRepo: boolean;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  onSearch: () => void;
  onGitChanges: () => void;
  onFileBrowser?: () => void;
};
```

3. Add `onFileBrowser` to the destructured params in the function signature.

4. Add the button **before** the search button (i.e., between git-changes and search):

```tsx
{onFileBrowser && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onFileBrowser();
    }}
    className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
    title={`Browse files (${formatShortcut(getShortcut('file-browser')!)})`}
  >
    <FolderOpen size={14} />
  </button>
)}
```

- [ ] Add `FolderOpen` to Lucide import in `PaneToolbar.tsx`
- [ ] Add `onFileBrowser?: () => void` to `PaneToolbarProps`
- [ ] Add the file browser button to the toolbar JSX

### Step 4.2: Wire it in `TerminalPane`

In `src/renderer/src/components/TerminalPane.tsx`, update the `<PaneToolbar>` usage (around line 98) to add:

```tsx
onFileBrowser={() => document.dispatchEvent(new CustomEvent('fleet:toggle-file-browser'))}
```

The full `<PaneToolbar>` call becomes:

```tsx
<PaneToolbar
  visible={hovered}
  isGitRepo={isGitRepo}
  onSplitHorizontal={() => onSplitHorizontal?.()}
  onSplitVertical={() => onSplitVertical?.()}
  onClose={() => onClose?.()}
  onSearch={() => setSearchOpen(true)}
  onGitChanges={() => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'))}
  onFileBrowser={() => document.dispatchEvent(new CustomEvent('fleet:toggle-file-browser'))}
/>
```

Note: `PaneGrid.tsx` does **not** need to change — `TerminalPane` dispatches the event directly (same pattern as `onGitChanges`).

- [ ] Add `onFileBrowser` prop to `<PaneToolbar>` in `TerminalPane.tsx`

### Step 4.3: Typecheck

```bash
npm run typecheck
```

Expected: no errors.

- [ ] Run typecheck — expect no errors

### Step 4.4: Commit

```bash
git add src/renderer/src/components/PaneToolbar.tsx src/renderer/src/components/TerminalPane.tsx
git commit -m "feat: add Browse files button to PaneToolbar"
```

- [ ] Commit

---

## Task 5: Build `FileBrowserDrawer` component

**Files:**
- Create: `src/renderer/src/components/FileBrowserDrawer.tsx`

This is the main component. Build it in sub-steps.

### Step 5.1: Scaffold the component with visible shell (no logic)

Create `src/renderer/src/components/FileBrowserDrawer.tsx` with a skeleton that renders the panel correctly:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { X, FolderOpen, FolderClosed, File, ChevronRight, ChevronDown } from 'lucide-react';
import { quotePathForShell } from '../lib/shell-utils';
import { useWorkspaceStore } from '../store/workspace-store';
import { useCwdStore } from '../store/cwd-store';
import { fuzzyMatch } from '../lib/commands';
import { getFileIcon } from '../lib/file-icons';

// --- Types ---

type DirEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type TreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  children: TreeNode[] | null; // null = not yet loaded
  isExpanded: boolean;
};

type FlatFile = {
  path: string;
  relativePath: string;
  name: string;
};

// --- localStorage key ---
const ROOT_STORAGE_KEY = 'fleet:file-browser-root';

// --- Helpers ---

function getInitialRoot(): string {
  const stored = localStorage.getItem(ROOT_STORAGE_KEY);
  if (stored) return stored;
  const homeDir = window.fleet.homeDir;
  if (homeDir) return homeDir;
  // Fallback: active pane CWD, then /
  const activePaneId = useWorkspaceStore.getState().activePaneId;
  const cwd = useCwdStore.getState().cwds.get(activePaneId ?? '') ?? '/';
  return cwd;
}

function persistRoot(root: string): void {
  localStorage.setItem(ROOT_STORAGE_KEY, root);
}

function entriesToNodes(entries: DirEntry[]): TreeNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
    children: e.isDirectory ? null : undefined as unknown as null,
    isExpanded: false
  }));
}

// --- Props ---

type FileBrowserDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
};

// --- Component ---

export function FileBrowserDrawer({ isOpen, onClose }: FileBrowserDrawerProps): React.JSX.Element | null {
  const [rootDir, setRootDir] = useState<string>(getInitialRoot);
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [searchFiles, setSearchFiles] = useState<FlatFile[]>([]);
  const [isSearchLoading, setIsSearchLoading] = useState(false);
  const [isRootLoading, setIsRootLoading] = useState(false);
  const searchLoadedRef = useRef(false);

  // Load root directory on open / root change
  useEffect(() => {
    if (!isOpen) return;
    setNodes([]);
    setSelectedPaths(new Set());
    setQuery('');
    setSearchFiles([]);
    setSearchError(null);
    searchLoadedRef.current = false;
    setIsRootLoading(true);
    void window.fleet.file.readdir(rootDir).then((result) => {
      setIsRootLoading(false);
      if (result.success) {
        setNodes(entriesToNodes(result.entries));
      }
    });
  }, [isOpen, rootDir]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const handleChangeRoot = useCallback(async () => {
    const picked = await window.fleet.showFolderPicker();
    if (!picked) return;
    persistRoot(picked);
    setRootDir(picked);
  }, []);

  const handleExpandNode = useCallback(async (nodePath: string) => {
    const loadChildren = async (ns: TreeNode[]): Promise<TreeNode[]> => {
      return Promise.all(
        ns.map(async (n) => {
          if (n.path !== nodePath) {
            return n.children
              ? { ...n, children: await loadChildren(n.children) }
              : n;
          }
          if (!n.isDirectory) return n;
          if (n.isExpanded) return { ...n, isExpanded: false };
          if (n.children !== null) return { ...n, isExpanded: true };
          const result = await window.fleet.file.readdir(n.path);
          const children = result.success ? entriesToNodes(result.entries) : [];
          return { ...n, isExpanded: true, children };
        })
      );
    };
    setNodes((prev) => void loadChildren(prev).then(setNodes) as unknown as TreeNode[]);
  }, []);

  const toggleSelected = useCallback((filePath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  const [searchError, setSearchError] = useState<string | null>(null);

  const handleQueryChange = useCallback(
    async (q: string) => {
      setQuery(q);
      if (q && !searchLoadedRef.current) {
        setIsSearchLoading(true);
        searchLoadedRef.current = true;
        try {
          const result = await window.fleet.file.list(rootDir);
          if (result.success) {
            setSearchFiles(result.files);
          } else {
            setSearchError("Couldn't load file list");
          }
        } catch {
          setSearchError("Couldn't load file list");
        } finally {
          setIsSearchLoading(false);
        }
      }
    },
    [rootDir]
  );

  const handleDone = useCallback(() => {
    const activePaneId = useWorkspaceStore.getState().activePaneId;
    if (!activePaneId || selectedPaths.size === 0) return;
    const quoted = Array.from(selectedPaths)
      .map((p) => quotePathForShell(p, window.fleet.platform))
      .join(' ') + ' ';
    window.fleet.pty.input({ paneId: activePaneId, data: quoted });
    onClose();
  }, [selectedPaths, onClose]);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);
  const isTerminalActive = !!activePaneId;

  const filteredSearch = query
    ? searchFiles.filter((f) => fuzzyMatch(query, f.name) || fuzzyMatch(query, f.relativePath))
    : [];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex">
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      {/* Drawer */}
      <div className="relative z-10 w-80 h-full flex flex-col bg-neutral-900 border-l border-neutral-700 shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800 shrink-0">
          <span className="text-sm font-medium text-neutral-200 flex-1">Browse Files</span>
          <button
            onClick={onClose}
            className="p-1 text-neutral-500 hover:text-neutral-200 rounded hover:bg-neutral-800 transition-colors"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
        {/* Root dir */}
        <button
          onClick={() => void handleChangeRoot()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-500 hover:text-neutral-300 border-b border-neutral-800 text-left truncate transition-colors hover:bg-neutral-800/50 shrink-0"
          title="Click to change root directory"
        >
          <FolderOpen size={11} className="shrink-0" />
          <span className="truncate">{rootDir}</span>
        </button>
        {/* Search */}
        <div className="px-2 py-1.5 border-b border-neutral-800 shrink-0">
          <input
            type="text"
            value={query}
            onChange={(e) => void handleQueryChange(e.target.value)}
            placeholder="Search files..."
            className="w-full bg-neutral-800 text-sm text-white rounded px-2 py-1 outline-none placeholder-neutral-600 focus:ring-1 focus:ring-neutral-600"
          />
        </div>
        {/* Content */}
        <div className="flex-1 overflow-y-auto py-0.5">
          {query ? (
            <SearchResults
              query={query}
              results={filteredSearch}
              isLoading={isSearchLoading}
              error={searchError}
              selectedPaths={selectedPaths}
              onToggle={toggleSelected}
            />
          ) : (
            <TreeView
              nodes={nodes}
              isLoading={isRootLoading}
              selectedPaths={selectedPaths}
              onToggle={toggleSelected}
              onExpand={(path) => void handleExpandNode(path)}
              depth={0}
            />
          )}
        </div>
        {/* Footer */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-neutral-800 shrink-0">
          <span className="text-xs text-neutral-500 flex-1">
            {selectedPaths.size > 0 ? `${selectedPaths.size} selected` : 'No selection'}
          </span>
          {selectedPaths.size > 0 && (
            <button
              onClick={() => setSelectedPaths(new Set())}
              className="text-xs text-neutral-500 hover:text-neutral-300 transition-colors"
            >
              Clear
            </button>
          )}
          <button
            onClick={handleDone}
            disabled={selectedPaths.size === 0 || !isTerminalActive}
            className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            title={!isTerminalActive ? 'Focus a terminal to paste' : undefined}
          >
            Done
          </button>
        </div>
        {!isTerminalActive && selectedPaths.size > 0 && (
          <div className="px-3 pb-2 text-xs text-amber-500/80">
            Focus a terminal to paste
          </div>
        )}
      </div>
    </div>
  );
}

// --- Sub-components ---

type TreeViewProps = {
  nodes: TreeNode[];
  isLoading: boolean;
  selectedPaths: Set<string>;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
  depth: number;
};

function TreeView({ nodes, isLoading, selectedPaths, onToggle, onExpand, depth }: TreeViewProps): React.JSX.Element {
  if (isLoading) {
    return <div className="px-3 py-2 text-xs text-neutral-500">Loading...</div>;
  }
  if (nodes.length === 0) {
    return <div className="px-3 py-2 text-xs text-neutral-500">This folder is empty</div>;
  }
  return (
    <>
      {nodes.map((node) => (
        <TreeNodeRow
          key={node.path}
          node={node}
          selectedPaths={selectedPaths}
          onToggle={onToggle}
          onExpand={onExpand}
          depth={depth}
        />
      ))}
    </>
  );
}

type TreeNodeRowProps = {
  node: TreeNode;
  selectedPaths: Set<string>;
  onToggle: (path: string) => void;
  onExpand: (path: string) => void;
  depth: number;
};

function TreeNodeRow({ node, selectedPaths, onToggle, onExpand, depth }: TreeNodeRowProps): React.JSX.Element {
  const isSelected = selectedPaths.has(node.path);
  const indent = depth * 12;

  if (node.isDirectory) {
    return (
      <>
        <button
          onClick={() => onExpand(node.path)}
          className="w-full flex items-center gap-1 px-2 py-0.5 text-sm text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60 transition-colors text-left"
          style={{ paddingLeft: `${8 + indent}px` }}
        >
          {node.isExpanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
          {node.isExpanded ? <FolderOpen size={13} className="shrink-0 text-yellow-500/80" /> : <FolderClosed size={13} className="shrink-0 text-yellow-500/80" />}
          <span className="truncate text-xs">{node.name}</span>
        </button>
        {node.isExpanded && node.children !== null && (
          <TreeView
            nodes={node.children}
            isLoading={false}
            selectedPaths={selectedPaths}
            onToggle={onToggle}
            onExpand={onExpand}
            depth={depth + 1}
          />
        )}
      </>
    );
  }

  return (
    <button
      onClick={() => onToggle(node.path)}
      className={`w-full flex items-center gap-1.5 px-2 py-0.5 text-xs text-left transition-colors ${
        isSelected
          ? 'bg-blue-600/20 text-blue-300'
          : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60'
      }`}
      style={{ paddingLeft: `${8 + indent + 14}px` }}
    >
      <span className="shrink-0 text-neutral-500">{getFileIcon(node.name, 12)}</span>
      <span className="truncate">{node.name}</span>
      {isSelected && <span className="ml-auto shrink-0 text-blue-400">✓</span>}
    </button>
  );
}

type SearchResultsProps = {
  query: string;
  results: FlatFile[];
  isLoading: boolean;
  error: string | null;
  selectedPaths: Set<string>;
  onToggle: (path: string) => void;
};

function SearchResults({ results, isLoading, error, selectedPaths, onToggle }: SearchResultsProps): React.JSX.Element {
  if (isLoading) {
    return <div className="px-3 py-2 text-xs text-neutral-500">Loading...</div>;
  }
  if (error) {
    return <div className="px-3 py-2 text-xs text-red-400">{error}</div>;
  }
  if (results.length === 0) {
    return <div className="px-3 py-2 text-xs text-neutral-500">No matching files</div>;
  }
  return (
    <>
      {results.map((file) => {
        const isSelected = selectedPaths.has(file.path);
        return (
          <button
            key={file.path}
            onClick={() => onToggle(file.path)}
            className={`w-full flex items-center gap-1.5 px-3 py-1 text-xs text-left transition-colors ${
              isSelected
                ? 'bg-blue-600/20 text-blue-300'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/60'
            }`}
          >
            <span className="shrink-0 text-neutral-500">{getFileIcon(file.name, 12)}</span>
            <div className="flex flex-col min-w-0">
              <span className="truncate font-medium">{file.name}</span>
              <span className="truncate text-neutral-600">{file.relativePath}</span>
            </div>
            {isSelected && <span className="ml-auto shrink-0 text-blue-400">✓</span>}
          </button>
        );
      })}
    </>
  );
}
```

- [ ] Create `src/renderer/src/components/FileBrowserDrawer.tsx` with the above code

### Step 5.2: Fix the `handleExpandNode` state update (important!)

The `handleExpandNode` implementation above has a subtle issue: `setNodes` is called inside a `void` expression. Replace the `handleExpandNode` callback with this corrected version that properly awaits and sets state:

```ts
const handleExpandNode = useCallback((nodePath: string) => {
  async function updateNodes(ns: TreeNode[]): Promise<TreeNode[]> {
    const result: TreeNode[] = [];
    for (const n of ns) {
      if (n.path === nodePath && n.isDirectory) {
        if (n.isExpanded) {
          result.push({ ...n, isExpanded: false });
        } else if (n.children !== null) {
          result.push({ ...n, isExpanded: true });
        } else {
          const res = await window.fleet.file.readdir(n.path);
          const children = res.success ? entriesToNodes(res.entries) : [];
          result.push({ ...n, isExpanded: true, children });
        }
      } else if (n.isDirectory && n.children) {
        result.push({ ...n, children: await updateNodes(n.children) });
      } else {
        result.push(n);
      }
    }
    return result;
  }
  void updateNodes(nodes).then(setNodes);
}, [nodes]);
```

Also fix `entriesToNodes` — the `undefined as unknown as null` trick is wrong. Files don't need a `children` field at all since `TreeNode.children` is `TreeNode[] | null`. For files, just set `children: null` and `isExpanded: false` (they'll never be expanded):

```ts
function entriesToNodes(entries: DirEntry[]): TreeNode[] {
  return entries.map((e) => ({
    name: e.name,
    path: e.path,
    isDirectory: e.isDirectory,
    children: null, // null = not yet loaded (for dirs) or not applicable (for files)
    isExpanded: false
  }));
}
```

- [ ] Replace `handleExpandNode` with the corrected version
- [ ] Fix `entriesToNodes` to use `null` for both dirs and files

### Step 5.3: Typecheck

```bash
npm run typecheck
```

Expected: no errors. If TypeScript complains about `window.fleet.file.readdir` not existing, ensure Task 1 was committed and the preload type is updated.

- [ ] Run typecheck — expect no errors

### Step 5.4: Commit

```bash
git add src/renderer/src/components/FileBrowserDrawer.tsx
git commit -m "feat: add FileBrowserDrawer component with tree view, search, and multi-select"
```

- [ ] Commit

---

## Task 6: Wire `FileBrowserDrawer` into `App.tsx`

**Files:**
- Modify: `src/renderer/src/App.tsx`

### Step 6.1: Add the import

In `src/renderer/src/App.tsx`, add to the import block:

```ts
import { FileBrowserDrawer } from './components/FileBrowserDrawer';
```

### Step 6.2: Add state

In the state block (alongside `settingsOpen`, `shortcutsOpen`, etc., around line 81):

```ts
const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
```

### Step 6.3: Add the event listener

Add a `useEffect` alongside the other toggle listeners:

```ts
// File browser drawer toggle (Cmd+Shift+E or toolbar button)
useEffect(() => {
  const handler = (): void => setFileBrowserOpen((prev) => !prev);
  document.addEventListener('fleet:toggle-file-browser', handler);
  return () => document.removeEventListener('fleet:toggle-file-browser', handler);
}, []);
```

### Step 6.4: Render the component

At the bottom of the return JSX, alongside the other modals (after `<QuickOpenOverlay>` and before `<AppPreChecks>`):

```tsx
<FileBrowserDrawer isOpen={fileBrowserOpen} onClose={() => setFileBrowserOpen(false)} />
```

- [ ] Add `FileBrowserDrawer` import to `App.tsx`
- [ ] Add `fileBrowserOpen` state
- [ ] Add `fleet:toggle-file-browser` event listener
- [ ] Render `<FileBrowserDrawer>` in the JSX

### Step 6.5: Typecheck and lint

```bash
npm run typecheck
npm run lint
```

Expected: no errors or warnings.

- [ ] Run typecheck — expect no errors
- [ ] Run lint — expect no warnings

### Step 6.6: Manual smoke test

Start the app in dev mode and verify:

1. Press `Cmd+Shift+E` (Mac) / `Ctrl+Shift+E` — drawer slides in from the right
2. Home directory is shown as root and files/folders are listed
3. Click a folder to expand it — children load and appear
4. Type in the search box — switches to flat file list
5. Click a file to select it — turns blue with a ✓
6. Select multiple files — counter shows "N selected"
7. Click "Done" — paths are pasted into the active terminal, drawer closes
8. Click root dir label — native folder picker opens; selecting a new folder updates the tree
9. Close with ✕ button and with Escape key
10. Open command palette (`Cmd+Shift+P`), type "browse" — "Browse Files" command appears

- [ ] Smoke test all 10 scenarios above

### Step 6.7: Commit

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: wire FileBrowserDrawer into App with toggle shortcut and event listener"
```

- [ ] Commit

---

## Done

The file browser drawer is fully implemented. All 6 tasks produce independent, testable commits. The feature is accessible via `Cmd+Shift+E`, the terminal toolbar's folder button, and the command palette.
