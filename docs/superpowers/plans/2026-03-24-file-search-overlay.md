# File Search Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Spotlight-style file search overlay that uses OS-level search (`mdfind`, `locate`, `find`) to find files across the filesystem and paste the selected path into the active terminal pane.

**Architecture:** New IPC channel `FILE_SEARCH` connects a renderer overlay component to a main-process search backend that spawns OS-native search commands. The overlay follows the same modal pattern as `QuickOpenOverlay` but targets the whole filesystem instead of the workspace.

**Tech Stack:** Electron IPC, `child_process.spawn`, `mdfind`/`locate`/`find`, React, xterm.js `pty.input`

**Spec:** `docs/superpowers/specs/2026-03-24-file-search-overlay-design.md`

---

### Task 1: IPC Channel & Type Definitions

**Files:**

- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add IPC channel constant**

In `src/shared/ipc-channels.ts`, add after `FILE_OPEN_IN_TAB`:

```ts
FILE_SEARCH: 'file:search',
```

- [ ] **Step 2: Add type definitions**

In `src/shared/ipc-api.ts`, add at the end (before the closing of the file):

```ts
export type FileSearchRequest = {
  requestId: number;
  query: string;
  scope?: string;
  limit?: number;
};

export type FileSearchResult = {
  path: string;
  name: string;
  parentDir: string;
  modifiedAt: number;
  size: number;
};

export type FileSearchResponse =
  | { success: true; requestId: number; results: FileSearchResult[] }
  | { success: false; requestId: number; error: string };
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(file-search): add IPC channel and type definitions"
```

---

### Task 2: Search Backend (Main Process)

**Files:**

- Create: `src/main/file-search.ts`

- [ ] **Step 1: Create the search module**

Create `src/main/file-search.ts`. This module exports a single `searchFiles` function that:

1. Picks the right OS search command based on `process.platform`
2. Spawns a child process, stores its handle for cancellation
3. Parses output lines into file paths
4. Calls `fs.stat()` on each path for metadata
5. Deduplicates by resolved path
6. Returns results sorted by `modifiedAt` descending

```ts
import { spawn, type ChildProcess } from 'child_process';
import { stat, realpath } from 'fs/promises';
import { basename, dirname } from 'path';
import { homedir } from 'os';
import type { FileSearchRequest, FileSearchResponse, FileSearchResult } from '../shared/ipc-api';

let activeProcess: ChildProcess | null = null;

function killActive(): void {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill('SIGTERM');
  }
  activeProcess = null;
}

function buildCommand(
  query: string,
  scope: string | undefined,
  limit: number
): { cmd: string; args: string[] } {
  const platform = process.platform;
  const searchScope = scope ?? homedir();
  const escapedQuery = query.replace(/'/g, "\\'");

  if (platform === 'darwin') {
    // mdfind — Spotlight CLI, instant indexed search
    return {
      cmd: 'mdfind',
      args: ['-onlyin', searchScope, `kMDItemDisplayName == '*${escapedQuery}*'cd`]
    };
  }

  if (platform === 'linux') {
    // Try locate first; caller handles fallback if not found
    return {
      cmd: 'locate',
      args: ['-i', '-l', String(limit), '--', `*${query}*`]
    };
  }

  // Windows: try Everything CLI (es.exe) first via PATH, fall back to PowerShell
  // The caller handles ENOENT fallback to PowerShell (same pattern as Linux locate→find)
  return {
    cmd: 'es.exe',
    args: ['-i', '-n', String(limit), '-path', searchScope, query]
  };
}

async function statResult(filePath: string): Promise<FileSearchResult | null> {
  try {
    const resolved = await realpath(filePath);
    const s = await stat(resolved);
    if (!s.isFile()) return null;
    return {
      path: resolved,
      name: basename(resolved),
      parentDir: dirname(resolved),
      modifiedAt: s.mtimeMs,
      size: s.size
    };
  } catch {
    return null;
  }
}

export async function searchFiles(req: FileSearchRequest): Promise<FileSearchResponse> {
  killActive();

  const { requestId, query, scope } = req;
  const limit = req.limit ?? 20;

  if (!query.trim()) {
    return { success: true, requestId, results: [] };
  }

  const { cmd, args } = buildCommand(query, scope, limit);

  return new Promise((resolve) => {
    const isNonIndexed = cmd === 'powershell' || cmd === 'find';
    const timeout = isNonIndexed ? 5000 : 15000;

    let stdout = '';
    let timedOut = false;

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;

      // If locate/es.exe not found, fallback to find (Linux) or PowerShell (Windows)
      if (
        (err as NodeJS.ErrnoException).code === 'ENOENT' &&
        (cmd === 'locate' || cmd === 'es.exe')
      ) {
        const fallbackScope = scope ?? homedir();
        const isWin = process.platform === 'win32';
        const fallbackCmd = isWin ? 'powershell' : 'find';
        const fallbackArgs = isWin
          ? [
              '-NoProfile',
              '-Command',
              `Get-ChildItem -Path '${fallbackScope}' -Recurse -Filter '*${query}*' -File -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`
            ]
          : [fallbackScope, '-maxdepth', '5', '-iname', `*${query}*`, '-type', 'f'];
        const findProc = spawn(fallbackCmd, fallbackArgs, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        activeProcess = findProc;
        let findStdout = '';

        const findTimer = setTimeout(() => {
          findProc.kill('SIGTERM');
        }, 5000);

        findProc.stdout.on('data', (chunk: Buffer) => {
          findStdout += chunk.toString();
        });

        findProc.on('close', () => {
          clearTimeout(findTimer);
          activeProcess = null;
          void processResults(findStdout, limit, requestId).then(resolve);
        });

        findProc.on('error', () => {
          clearTimeout(findTimer);
          activeProcess = null;
          resolve({ success: false, requestId, error: 'No search tool available' });
        });
        return;
      }

      resolve({ success: false, requestId, error: `Search failed: ${err.message}` });
    });

    proc.on('close', () => {
      clearTimeout(timer);
      activeProcess = null;

      if (timedOut && !stdout.trim()) {
        resolve({ success: false, requestId, error: 'Search timed out' });
        return;
      }

      void processResults(stdout, limit, requestId).then(resolve);
    });
  });
}

async function processResults(
  stdout: string,
  limit: number,
  requestId: number
): Promise<FileSearchResponse> {
  const paths = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, limit * 2); // over-fetch to account for stat failures

  const seen = new Set<string>();
  const results: FileSearchResult[] = [];

  for (const p of paths) {
    if (results.length >= limit) break;
    const result = await statResult(p);
    if (result && !seen.has(result.path)) {
      seen.add(result.path);
      results.push(result);
    }
  }

  results.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { success: true, requestId, results };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/file-search.ts
git commit -m "feat(file-search): add platform-specific search backend"
```

---

### Task 3: Register IPC Handler

**Files:**

- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Import and register the handler**

At the top of `src/main/ipc-handlers.ts`, add the import:

```ts
import { searchFiles } from './file-search';
import type { FileSearchRequest } from '../shared/ipc-api';
```

Then in the `registerIpcHandlers` function, add a new handler (near the other `FILE_*` handlers):

```ts
ipcMain.handle(IPC_CHANNELS.FILE_SEARCH, async (_event, req: FileSearchRequest) =>
  searchFiles(req)
);
```

- [ ] **Step 2: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(file-search): register IPC handler in main process"
```

---

### Task 4: Expose in Preload Bridge

**Files:**

- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add import**

Add `FileSearchRequest` and `FileSearchResponse` to the import from `../shared/ipc-api`:

```ts
import type {
  // ... existing imports ...
  FileSearchRequest,
  FileSearchResponse,
  ReaddirResponse
} from '../shared/ipc-api';
```

- [ ] **Step 2: Add to fleetApi.file namespace**

In the `file` object of `fleetApi`, add after the `stat` method:

```ts
search: async (req: FileSearchRequest): Promise<FileSearchResponse> =>
  typedInvoke(IPC_CHANNELS.FILE_SEARCH, req),
```

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(file-search): expose search API in preload bridge"
```

---

### Task 5: Add Shortcut & Command Palette Entry

**Files:**

- Modify: `src/renderer/src/lib/shortcuts.ts`
- Modify: `src/renderer/src/lib/commands.ts`

- [ ] **Step 1: Add shortcut definition**

In `src/renderer/src/lib/shortcuts.ts`, add to the `ALL_SHORTCUTS` array after the `file-browser` entry:

```ts
{
  id: 'file-search',
  label: 'Search files on disk',
  mac: { key: 'O', meta: true, shift: true },
  other: { key: 'O', ctrl: true, shift: true }
}
```

- [ ] **Step 2: Add command palette entry**

In `src/renderer/src/lib/commands.ts`, add to the array returned by `createCommandRegistry()` after the `file-browser` entry:

```ts
{
  id: 'file-search',
  label: 'Search Files on Disk',
  shortcut: sc('file-search'),
  category: 'File',
  execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-file-search'))
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/shortcuts.ts src/renderer/src/lib/commands.ts
git commit -m "feat(file-search): add keyboard shortcut and command palette entry"
```

---

### Task 6: FileSearchOverlay Component

**Files:**

- Create: `src/renderer/src/components/FileSearchOverlay.tsx`

- [ ] **Step 1: Create the overlay component**

Create `src/renderer/src/components/FileSearchOverlay.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspace-store';
import { quotePathForShell } from '../lib/shell-utils';
import { getFileIcon } from '../lib/file-icons';
import type { FileSearchResult } from '../../../shared/ipc-api';

const RECENT_STORAGE_KEY = 'fleet:file-search-recent';
const MAX_RECENT = 20;

// --- Recent files LRU ---

function getRecentFiles(): FileSearchResult[] {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as FileSearchResult[]) : [];
  } catch {
    return [];
  }
}

function addRecentFile(file: FileSearchResult): void {
  const recent = getRecentFiles().filter((f) => f.path !== file.path);
  recent.unshift(file);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(recent));
}

// --- Relative time formatting ---

function relativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

// --- Highlight matched characters ---

function HighlightedText({ text, query }: { text: string; query: string }): React.JSX.Element {
  if (!query) return <span>{text}</span>;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const chars: React.ReactNode[] = [];
  let qi = 0;
  for (let i = 0; i < text.length; i++) {
    if (qi < q.length && t[i] === q[qi]) {
      chars.push(
        <span key={i} className="text-blue-400 font-semibold">
          {text[i]}
        </span>
      );
      qi++;
    } else {
      chars.push(<span key={i}>{text[i]}</span>);
    }
  }
  return <>{chars}</>;
}

// --- Scope pill with dropdown ---

function ScopePill({
  scope,
  scopeLabel,
  onSetScope
}: {
  scope: string | undefined;
  scopeLabel: string;
  onSetScope: (s: string | undefined) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const handlePickFolder = async (): Promise<void> => {
    setOpen(false);
    const picked = await window.fleet.showFolderPicker();
    if (picked) onSetScope(picked);
  };

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((p) => !p)}
        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-neutral-800 text-neutral-400 rounded border border-neutral-700 hover:text-neutral-200"
      >
        {scopeLabel}
        <X size={10} className={scope ? '' : 'hidden'} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 z-20 bg-neutral-800 border border-neutral-700 rounded-md shadow-lg py-1 min-w-[140px]">
            <button
              className="w-full px-3 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => {
                onSetScope(undefined);
                setOpen(false);
              }}
            >
              Everywhere
            </button>
            <button
              className="w-full px-3 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => {
                onSetScope(window.fleet.homeDir);
                setOpen(false);
              }}
            >
              Home (~)
            </button>
            <button
              className="w-full px-3 py-1.5 text-xs text-neutral-300 hover:text-white hover:bg-neutral-700 text-left"
              onClick={() => void handlePickFolder()}
            >
              Choose folder...
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// --- Props ---

type FileSearchOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
};

// --- Component ---

export function FileSearchOverlay({
  isOpen,
  onClose
}: FileSearchOverlayProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<string | undefined>(undefined);
  const [results, setResults] = useState<FileSearchResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);

  // Reset state on open
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setScope(undefined);
      setResults(getRecentFiles());
      setSelectedIndex(0);
      setIsLoading(false);
      setError(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Debounced search
  useEffect(() => {
    if (!isOpen) return;

    if (!query.trim()) {
      setResults(getRecentFiles());
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(() => {
      const id = ++requestIdRef.current;
      void window.fleet.file
        .search({
          requestId: id,
          query: query.trim(),
          scope,
          limit: 20
        })
        .then((res) => {
          // Discard stale responses
          if (id !== requestIdRef.current) return;
          setIsLoading(false);
          if (res.success) {
            setResults(res.results);
            setError(null);
          } else {
            setResults([]);
            setError(res.error);
          }
        });
    }, 150);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, query, scope]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Scroll selected into view
  useEffect(() => {
    const child = listRef.current?.children[selectedIndex];
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (file: FileSearchResult) => {
      if (!activePaneId) return;
      const quoted = quotePathForShell(file.path, window.fleet.platform) + ' ';
      window.fleet.pty.input({ paneId: activePaneId, data: quoted });
      addRecentFile(file);
      onClose();
    },
    [activePaneId, onClose]
  );

  const handleScopeToParent = useCallback(() => {
    const file = results[selectedIndex];
    if (file) {
      setScope(file.parentDir);
    }
  }, [results, selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const file = results[selectedIndex];
      if (file) handleSelect(file);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleScopeToParent();
    } else if (e.key === 'Backspace' && query === '' && scope) {
      e.preventDefault();
      setScope(undefined);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  const scopeLabel = scope ? scope.replace(window.fleet.homeDir, '~') : 'Everywhere';

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <Search size={14} className="text-neutral-500 shrink-0" />
          <ScopePill scope={scope} scopeLabel={scopeLabel} onSetScope={setScope} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={scope ? 'Search in folder...' : 'Search files on disk...'}
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          {isLoading && <span className="text-xs text-neutral-500">Searching...</span>}
        </div>

        {/* Results */}
        <div ref={listRef} className="overflow-y-auto py-1">
          {!query && results.length > 0 && (
            <div className="px-3 py-1 text-[10px] text-neutral-600 uppercase tracking-wider">
              Recent
            </div>
          )}
          {error ? (
            <div className="px-3 py-4 text-sm text-red-400/80 text-center">{error}</div>
          ) : results.length === 0 && !isLoading ? (
            <div className="px-3 py-4 text-sm text-neutral-500 text-center">
              {query ? 'No files found' : 'No recent files'}
            </div>
          ) : (
            results.slice(0, 10).map((file, i) => (
              <button
                key={file.path}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                  i === selectedIndex
                    ? 'bg-neutral-700 text-white'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => handleSelect(file)}
              >
                <span className="text-neutral-500 shrink-0">{getFileIcon(file.name)}</span>
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="truncate font-medium">
                    <HighlightedText text={file.name} query={query} />
                  </span>
                  <span className="truncate text-xs text-neutral-600">
                    {file.parentDir.replace(window.fleet.homeDir, '~')}
                  </span>
                </div>
                <span className="text-[10px] text-neutral-600 shrink-0">
                  {relativeTime(file.modifiedAt)}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
          {!activePaneId ? (
            <span className="text-amber-500/80">No active terminal</span>
          ) : (
            <>
              <span>↑↓ navigate</span>
              <span>↵ paste</span>
              <span>⇥ scope to folder</span>
              <span>esc dismiss</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/FileSearchOverlay.tsx
git commit -m "feat(file-search): add FileSearchOverlay component"
```

---

### Task 7: Wire Overlay into App

**Files:**

- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add import**

Add to the imports section of `App.tsx`:

```ts
import { FileSearchOverlay } from './components/FileSearchOverlay';
```

- [ ] **Step 2: Add state and event listener**

Add state alongside the other overlay states (near `fileBrowserOpen`):

```ts
const [fileSearchOpen, setFileSearchOpen] = useState(false);
```

Add event listener alongside the other overlay listeners (near the `fleet:toggle-file-browser` listener):

```ts
// File search overlay toggle (Cmd+Shift+O or command palette)
useEffect(() => {
  const handler = (): void => setFileSearchOpen((prev) => !prev);
  document.addEventListener('fleet:toggle-file-search', handler);
  return () => document.removeEventListener('fleet:toggle-file-search', handler);
}, []);
```

- [ ] **Step 3: Mount the overlay**

Add the overlay in the JSX, next to the `FileBrowserDrawer`:

```tsx
<FileSearchOverlay isOpen={fileSearchOpen} onClose={() => setFileSearchOpen(false)} />
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(file-search): wire overlay into App with event listener"
```

---

### Task 8: Add Pane Toolbar Button

**Files:**

- Modify: `src/renderer/src/components/PaneToolbar.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`

- [ ] **Step 1: Add prop and button to PaneToolbar**

In `src/renderer/src/components/PaneToolbar.tsx`, add to the `PaneToolbarProps` type:

```ts
onFileSearch?: () => void;
```

Add a button in the JSX, after the file browser button and before the search button:

```tsx
{
  onFileSearch && (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onFileSearch();
      }}
      className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
      title={`Search files on disk (${formatShortcut(getShortcut('file-search')!)})`}
    >
      <Search size={14} />
    </button>
  );
}
```

Note: `Search` is already imported from `lucide-react` in this file.

- [ ] **Step 2: Pass the prop from TerminalPane**

In `src/renderer/src/components/TerminalPane.tsx`, find where `PaneToolbar` is rendered and add:

```ts
onFileSearch={() => document.dispatchEvent(new CustomEvent('fleet:toggle-file-search'))}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/PaneToolbar.tsx src/renderer/src/components/TerminalPane.tsx
git commit -m "feat(file-search): add toolbar button to trigger search overlay"
```

---

### Task 9: Typecheck & Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Run typecheck**

```bash
npm run typecheck
```

Expected: No errors. If there are type errors, fix them before proceeding.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: No errors.

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: Successful build.

- [ ] **Step 4: Manual smoke test**

Launch the app (`npm run dev`) and verify:

1. `Cmd+Shift+O` opens the overlay
2. Typing a filename shows results from the filesystem
3. Arrow keys navigate, Enter pastes the quoted path into the focused terminal
4. Tab scopes to the selected result's parent folder
5. Backspace on empty query clears scope
6. Escape dismisses
7. Recent files appear on empty query after pasting at least once
8. Command palette shows "Search Files on Disk"
9. Pane toolbar has the new search button

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(file-search): address typecheck and lint issues"
```
