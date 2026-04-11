# Telescope Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-mode telescope picker modal to Fleet — a unified fuzzy finder with Files, Grep, Browse, and Panes modes, two-column layout with preview panel, triggered from the pane toolbar and keyboard shortcut.

**Architecture:** Thin `TelescopeModal` shell component delegates to pluggable mode modules via a shared `TelescopeMode` interface. Each mode is a separate file. A new `FILE_GREP` IPC channel connects the Grep mode to a main-process backend that spawns `rg`/`grep`/`findstr`.

**Tech Stack:** React, TypeScript, Tailwind CSS, Radix UI Tooltip, lucide-react icons, Zustand (workspace store), Electron IPC, ripgrep/grep/findstr for content search.

**Spec:** `docs/superpowers/specs/2026-04-11-telescope-picker-design.md`

---

### Task 1: Types & Mode Interface

**Files:**
- Create: `src/renderer/src/components/Telescope/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/renderer/src/components/Telescope/types.ts
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type TelescopeItem = {
  id: string;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  meta?: string;
  /** Arbitrary data the mode needs for onSelect/renderPreview (file path, line number, pane id, etc.) */
  data?: Record<string, unknown>;
};

export type TelescopeMode = {
  id: string;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  onSearch: (query: string) => Promise<TelescopeItem[]> | TelescopeItem[];
  renderPreview: (item: TelescopeItem) => ReactNode;
  onSelect: (item: TelescopeItem) => void;
  onAltSelect?: (item: TelescopeItem) => void;
  /** Browse mode only: current path segments for breadcrumb display */
  breadcrumbs?: string[];
  /** Browse mode only: drill into a directory or jump to a breadcrumb path */
  onNavigate?: (dir: string) => void;
  /** Browse mode only: go up one directory */
  onNavigateUp?: () => void;
};
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No new errors from the types file (it's just type declarations).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/types.ts
git commit -m "feat(telescope): add TelescopeItem and TelescopeMode type definitions"
```

---

### Task 2: IPC — FILE_GREP Channel & Types

**Files:**
- Modify: `src/shared/ipc-channels.ts:32` (add after FILE_SEARCH)
- Modify: `src/shared/ipc-api.ts:138` (add after FileSearchResponse)

- [ ] **Step 1: Add the IPC channel constant**

In `src/shared/ipc-channels.ts`, add after the `FILE_SEARCH` line (line 32):

```typescript
  FILE_GREP: 'file:grep',
```

- [ ] **Step 2: Add the request/response types**

In `src/shared/ipc-api.ts`, add after the `FileSearchResponse` type (after line 138):

```typescript
export type FileGrepRequest = {
  requestId: number;
  query: string;
  cwd: string;
  limit?: number;
};

export type FileGrepResult = {
  file: string;
  relativePath: string;
  line: number;
  text: string;
  contextBefore?: string[];
  contextAfter?: string[];
};

export type FileGrepResponse =
  | { success: true; requestId: number; results: FileGrepResult[] }
  | { success: false; requestId: number; error: string };
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (new types are additive, nothing consumes them yet).

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/ipc-api.ts
git commit -m "feat(telescope): add FILE_GREP IPC channel and request/response types"
```

---

### Task 3: file-grep.ts Backend

**Files:**
- Create: `src/main/file-grep.ts`

This follows the exact same pattern as `src/main/file-search.ts` — spawn a process, parse stdout, normalize results, kill previous on new request.

- [ ] **Step 1: Create the file-grep module**

```typescript
// src/main/file-grep.ts
import { spawn, type ChildProcess } from 'child_process';
import { relative } from 'path';
import type { FileGrepRequest, FileGrepResponse, FileGrepResult } from '../shared/ipc-api';

let activeProcess: ChildProcess | null = null;

function killActive(): void {
  if (activeProcess && !activeProcess.killed) {
    activeProcess.kill('SIGTERM');
  }
  activeProcess = null;
}

function buildCommand(
  query: string,
  cwd: string,
  limit: number
): { cmd: string; args: string[] } {
  // Try ripgrep first (cross-platform, fast, respects .gitignore)
  return {
    cmd: 'rg',
    args: [
      '--no-heading',
      '--line-number',
      '--color', 'never',
      '--max-count', String(limit),
      '-B', '1',
      '-A', '1',
      '--', query, cwd
    ]
  };
}

function buildFallbackCommand(
  query: string,
  cwd: string,
  limit: number
): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return {
      cmd: 'findstr',
      args: ['/s', '/n', '/i', '/c:' + query, cwd + '\\*']
    };
  }
  return {
    cmd: 'grep',
    args: ['-rn', '-m', String(limit), '--include=*', '--', query, cwd]
  };
}

/**
 * Parse ripgrep output with context lines (-B1 -A1).
 * Format: filename:line:text  or  filename-line-text (context lines use -)
 * Group separator: --
 */
function parseRgOutput(stdout: string, cwd: string): FileGrepResult[] {
  const results: FileGrepResult[] = [];
  const blocks = stdout.split('--\n');

  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    let matchResult: FileGrepResult | null = null;
    const before: string[] = [];
    const after: string[] = [];

    for (const line of lines) {
      // Match line: file:line:text
      const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
      // Context line: file-line-text
      const contextLine = line.match(/^(.+?)-(\d+)-(.*)$/);

      if (matchLine && !matchResult) {
        matchResult = {
          file: matchLine[1],
          relativePath: relative(cwd, matchLine[1]),
          line: parseInt(matchLine[2], 10),
          text: matchLine[3],
          contextBefore: [],
          contextAfter: []
        };
      } else if (contextLine && !matchResult) {
        before.push(contextLine[3]);
      } else if (contextLine && matchResult) {
        after.push(contextLine[3]);
      } else if (matchLine && matchResult) {
        // Additional match in same block — flush current and start new
        matchResult.contextBefore = before.splice(0);
        matchResult.contextAfter = after.splice(0);
        results.push(matchResult);
        matchResult = {
          file: matchLine[1],
          relativePath: relative(cwd, matchLine[1]),
          line: parseInt(matchLine[2], 10),
          text: matchLine[3],
          contextBefore: [],
          contextAfter: []
        };
      }
    }

    if (matchResult) {
      matchResult.contextBefore = before;
      matchResult.contextAfter = after;
      results.push(matchResult);
    }
  }

  return results;
}

/**
 * Parse grep/findstr output (no context lines for simplicity).
 * Format: filename:line:text
 */
function parseFallbackOutput(stdout: string, cwd: string): FileGrepResult[] {
  const results: FileGrepResult[] = [];
  const lines = stdout.split('\n').filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      results.push({
        file: match[1],
        relativePath: relative(cwd, match[1]),
        line: parseInt(match[2], 10),
        text: match[3]
      });
    }
  }

  return results;
}

export async function grepFiles(req: FileGrepRequest): Promise<FileGrepResponse> {
  killActive();

  const { requestId, query, cwd } = req;
  const limit = req.limit ?? 50;

  if (!query.trim()) {
    return { success: true, requestId, results: [] };
  }

  const { cmd, args } = buildCommand(query, cwd, limit);

  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;

    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeProcess = proc;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, 10000);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeProcess = null;

      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode === 'ENOENT') {
        // rg not found — fall back
        const fallback = buildFallbackCommand(query, cwd, limit);
        let fallbackStdout = '';

        const fallbackProc = spawn(fallback.cmd, fallback.args, {
          stdio: ['ignore', 'pipe', 'pipe']
        });
        activeProcess = fallbackProc;

        const fallbackTimer = setTimeout(() => {
          fallbackProc.kill('SIGTERM');
        }, 10000);

        fallbackProc.stdout.on('data', (chunk: Buffer) => {
          fallbackStdout += chunk.toString();
        });

        fallbackProc.on('close', () => {
          clearTimeout(fallbackTimer);
          activeProcess = null;
          const results = parseFallbackOutput(fallbackStdout, cwd).slice(0, limit);
          resolve({ success: true, requestId, results });
        });

        fallbackProc.on('error', () => {
          clearTimeout(fallbackTimer);
          activeProcess = null;
          resolve({ success: false, requestId, error: 'No grep tool available' });
        });
        return;
      }

      resolve({ success: false, requestId, error: `Grep failed: ${err.message}` });
    });

    proc.on('close', () => {
      clearTimeout(timer);
      activeProcess = null;

      if (timedOut && !stdout.trim()) {
        resolve({ success: false, requestId, error: 'Grep timed out' });
        return;
      }

      const results = parseRgOutput(stdout, cwd).slice(0, limit);
      resolve({ success: true, requestId, results });
    });
  });
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/file-grep.ts
git commit -m "feat(telescope): add file-grep backend with rg/grep/findstr fallback"
```

---

### Task 4: Wire FILE_GREP into IPC & Preload

**Files:**
- Modify: `src/main/ipc-handlers.ts:425` (add after FILE_SEARCH handler)
- Modify: `src/preload/index.ts:204` (add after file.search in the file namespace)

- [ ] **Step 1: Register the IPC handler**

In `src/main/ipc-handlers.ts`, add the import at the top alongside the existing `searchFiles` import:

```typescript
import { grepFiles } from './file-grep';
```

Then add the handler after the `FILE_SEARCH` handler (after line 425):

```typescript
  ipcMain.handle(IPC_CHANNELS.FILE_GREP, async (_event, req: FileGrepRequest) =>
    grepFiles(req)
  );
```

Also add the `FileGrepRequest` import from `'../shared/ipc-api'` to the existing import statement.

- [ ] **Step 2: Add to preload API**

In `src/preload/index.ts`, add after `file.search` (after line 204):

```typescript
    grep: async (req: FileGrepRequest): Promise<FileGrepResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_GREP, req),
```

Also add `FileGrepRequest` and `FileGrepResponse` to the existing import from `'../shared/ipc-api'`.

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(telescope): wire FILE_GREP IPC handler and preload API"
```

---

### Task 5: Keyboard Shortcut Definition

**Files:**
- Modify: `src/renderer/src/lib/shortcuts.ts:145` (add before closing bracket of ALL_SHORTCUTS)

- [ ] **Step 1: Add the telescope shortcut**

In `src/renderer/src/lib/shortcuts.ts`, add to the `ALL_SHORTCUTS` array before the closing `]` (after the inject-skills entry ending on line 145):

```typescript
  {
    id: 'telescope',
    label: 'Telescope finder',
    mac: { key: 'T', meta: true, shift: true },
    other: { key: 'T', ctrl: true, shift: true }
  }
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/shortcuts.ts
git commit -m "feat(telescope): add Cmd+Shift+T keyboard shortcut definition"
```

---

### Task 6: Files Mode

**Files:**
- Create: `src/renderer/src/components/Telescope/modes/files-mode.ts`

- [ ] **Step 1: Create the files mode**

```typescript
// src/renderer/src/components/Telescope/modes/files-mode.ts
import { File } from 'lucide-react';
import { createElement } from 'react';
import { fuzzyMatch } from '../../../lib/commands';
import { getFileIcon } from '../../../lib/file-icons';
import { quotePathForShell, bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

type FileEntry = {
  path: string;
  relativePath: string;
  name: string;
};

let cachedFiles: FileEntry[] = [];
let cachedCwd: string | null = null;
let loadingPromise: Promise<void> | null = null;

function ensureFilesLoaded(cwd: string): void {
  if (cachedCwd === cwd && cachedFiles.length > 0) return;
  if (loadingPromise) return;
  cachedCwd = cwd;
  loadingPromise = window.fleet.file.list(cwd).then((result) => {
    if (result.success) {
      cachedFiles = result.files;
    }
    loadingPromise = null;
  });
}

export function createFilesMode(cwd: string, activePaneId: string | null): TelescopeMode {
  // Pre-load files on mode creation
  ensureFilesLoaded(cwd);

  return {
    id: 'files',
    label: 'Files',
    icon: File,
    placeholder: 'Search files by name...',

    onSearch: (query: string): TelescopeItem[] => {
      if (!query.trim()) {
        // Show recent files
        const recentFiles = useWorkspaceStore.getState().recentFiles;
        return recentFiles.slice(0, 15).map((filePath) => {
          const name = filePath.split('/').pop() ?? filePath;
          const parentDir = filePath.split('/').slice(0, -1).join('/');
          return {
            id: filePath,
            icon: getFileIcon(name, 14),
            title: name,
            subtitle: parentDir.replace(window.fleet.homeDir, '~'),
            meta: 'recent',
            data: { filePath }
          };
        });
      }

      return cachedFiles
        .filter((f) => fuzzyMatch(query, f.relativePath) || fuzzyMatch(query, f.name))
        .slice(0, 50)
        .map((f) => ({
          id: f.path,
          icon: getFileIcon(f.name, 14),
          title: f.name,
          subtitle: f.relativePath.includes('/')
            ? f.relativePath.split('/').slice(0, -1).join('/')
            : undefined,
          data: { filePath: f.path }
        }));
    },

    renderPreview: (item: TelescopeItem) => {
      // Preview rendering is handled by TelescopeModal via file.read()
      // Return null — the modal fetches content based on item.data.filePath
      return null;
    },

    onSelect: (item: TelescopeItem) => {
      const filePath = item.data?.filePath as string;
      if (filePath) {
        useWorkspaceStore.getState().openFile(filePath);
      }
    },

    onAltSelect: (item: TelescopeItem) => {
      const filePath = item.data?.filePath as string;
      if (filePath && activePaneId) {
        const quoted = quotePathForShell(filePath, window.fleet.platform) + ' ';
        window.fleet.pty.input({ paneId: activePaneId, data: bracketedPaste(quoted) });
      }
    }
  };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/modes/files-mode.ts
git commit -m "feat(telescope): add Files mode — fuzzy file search in cwd"
```

---

### Task 7: Grep Mode

**Files:**
- Create: `src/renderer/src/components/Telescope/modes/grep-mode.ts`

- [ ] **Step 1: Create the grep mode**

```typescript
// src/renderer/src/components/Telescope/modes/grep-mode.ts
import { TextSearch } from 'lucide-react';
import { createElement } from 'react';
import { quotePathForShell, bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

let requestCounter = 0;

export function createGrepMode(cwd: string, activePaneId: string | null): TelescopeMode {
  return {
    id: 'grep',
    label: 'Grep',
    icon: TextSearch,
    placeholder: 'Search file contents...',

    onSearch: async (query: string): Promise<TelescopeItem[]> => {
      if (!query.trim()) return [];

      const requestId = ++requestCounter;
      const res = await window.fleet.file.grep({
        requestId,
        query: query.trim(),
        cwd,
        limit: 50
      });

      // Discard stale responses
      if (requestId !== requestCounter) return [];

      if (!res.success) return [];

      return res.results.map((r) => ({
        id: `${r.file}:${r.line}`,
        icon: createElement('span', { className: 'text-[10px] text-neutral-500 font-mono w-4 text-right' }, String(r.line)),
        title: r.relativePath,
        subtitle: r.text.trim(),
        meta: `L${r.line}`,
        data: {
          filePath: r.file,
          line: r.line,
          contextBefore: r.contextBefore,
          contextAfter: r.contextAfter
        }
      }));
    },

    renderPreview: (item: TelescopeItem) => {
      // Preview rendering handled by TelescopeModal — fetches file content and scrolls to line
      return null;
    },

    onSelect: (item: TelescopeItem) => {
      const filePath = item.data?.filePath as string;
      if (filePath) {
        useWorkspaceStore.getState().openFile(filePath);
      }
    },

    onAltSelect: (item: TelescopeItem) => {
      const filePath = item.data?.filePath as string;
      const line = item.data?.line as number;
      if (filePath && activePaneId) {
        const text = quotePathForShell(filePath, window.fleet.platform) + ':' + line + ' ';
        window.fleet.pty.input({ paneId: activePaneId, data: bracketedPaste(text) });
      }
    }
  };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/modes/grep-mode.ts
git commit -m "feat(telescope): add Grep mode — content search via FILE_GREP IPC"
```

---

### Task 8: Browse Mode

**Files:**
- Create: `src/renderer/src/components/Telescope/modes/browse-mode.ts`

- [ ] **Step 1: Create the browse mode**

```typescript
// src/renderer/src/components/Telescope/modes/browse-mode.ts
import { FolderOpen, Folder, File } from 'lucide-react';
import { createElement } from 'react';
import { fuzzyMatch } from '../../../lib/commands';
import { getFileIcon } from '../../../lib/file-icons';
import { quotePathForShell, bracketedPaste } from '../../../lib/shell-utils';
import { useWorkspaceStore } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

type DirEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

type BrowseState = {
  currentDir: string;
  entries: DirEntry[];
  loading: boolean;
};

export function createBrowseMode(
  cwd: string,
  activePaneId: string | null,
  onStateChange: () => void
): TelescopeMode & { getState: () => BrowseState } {
  const state: BrowseState = {
    currentDir: cwd,
    entries: [],
    loading: true
  };

  function loadDir(dir: string): void {
    state.currentDir = dir;
    state.loading = true;
    state.entries = [];
    onStateChange();

    void window.fleet.file.readdir(dir).then((res) => {
      if (res.success) {
        state.entries = res.entries
          .sort((a, b) => {
            // Directories first, then alphabetical
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
          });
      }
      state.loading = false;
      onStateChange();
    });
  }

  // Initial load
  loadDir(cwd);

  function getBreadcrumbs(): string[] {
    const homeDir = window.fleet.homeDir;
    const dir = state.currentDir;
    if (dir.startsWith(homeDir)) {
      const rel = dir.slice(homeDir.length);
      const parts = rel.split('/').filter(Boolean);
      return ['~', ...parts];
    }
    return dir.split('/').filter(Boolean);
  }

  function breadcrumbToPath(index: number): string {
    const crumbs = getBreadcrumbs();
    if (crumbs[0] === '~') {
      if (index === 0) return window.fleet.homeDir;
      const parts = crumbs.slice(1, index + 1);
      return window.fleet.homeDir + '/' + parts.join('/');
    }
    const parts = crumbs.slice(0, index + 1);
    return '/' + parts.join('/');
  }

  return {
    id: 'browse',
    label: 'Browse',
    icon: FolderOpen,
    placeholder: 'Filter current directory...',

    get breadcrumbs(): string[] {
      return getBreadcrumbs();
    },

    onNavigate: (dir: string) => {
      loadDir(dir);
    },

    onNavigateUp: () => {
      const parent = state.currentDir.split('/').slice(0, -1).join('/') || '/';
      loadDir(parent);
    },

    onSearch: (query: string): TelescopeItem[] => {
      const filtered = query.trim()
        ? state.entries.filter((e) => fuzzyMatch(query, e.name))
        : state.entries;

      return filtered.map((entry) => ({
        id: entry.path,
        icon: entry.isDirectory
          ? createElement(Folder, { size: 14, className: 'text-blue-400' })
          : getFileIcon(entry.name, 14),
        title: entry.name,
        subtitle: entry.isDirectory ? 'Directory' : undefined,
        data: { filePath: entry.path, isDirectory: entry.isDirectory }
      }));
    },

    renderPreview: (item: TelescopeItem) => {
      // TelescopeModal handles: file.read() for files, file.readdir() for directories
      return null;
    },

    onSelect: (item: TelescopeItem) => {
      if (item.data?.isDirectory) {
        loadDir(item.data.filePath as string);
      } else {
        const filePath = item.data?.filePath as string;
        if (filePath) {
          useWorkspaceStore.getState().openFile(filePath);
        }
      }
    },

    onAltSelect: (item: TelescopeItem) => {
      const filePath = item.data?.filePath as string;
      if (filePath && activePaneId) {
        const quoted = quotePathForShell(filePath, window.fleet.platform) + ' ';
        window.fleet.pty.input({ paneId: activePaneId, data: bracketedPaste(quoted) });
      }
    },

    getState: () => state
  };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/modes/browse-mode.ts
git commit -m "feat(telescope): add Browse mode — directory navigation with breadcrumbs"
```

---

### Task 9: Panes Mode

**Files:**
- Create: `src/renderer/src/components/Telescope/modes/panes-mode.ts`

- [ ] **Step 1: Create the panes mode**

```typescript
// src/renderer/src/components/Telescope/modes/panes-mode.ts
import { TerminalSquare } from 'lucide-react';
import { createElement } from 'react';
import { fuzzyMatch } from '../../../lib/commands';
import { useWorkspaceStore, collectPaneLeafs } from '../../../store/workspace-store';
import type { TelescopeMode, TelescopeItem } from '../types';

export function createPanesMode(): TelescopeMode {
  return {
    id: 'panes',
    label: 'Panes',
    icon: TerminalSquare,
    placeholder: 'Search open panes...',

    onSearch: (query: string): TelescopeItem[] => {
      const state = useWorkspaceStore.getState();
      const activeTab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
      if (!activeTab) return [];

      const leafs = collectPaneLeafs(activeTab.splitRoot);

      const filtered = query.trim()
        ? leafs.filter((leaf) => {
            const label = leaf.label ?? leaf.paneType ?? 'terminal';
            return fuzzyMatch(query, label) || fuzzyMatch(query, leaf.cwd);
          })
        : leafs;

      return filtered.map((leaf) => {
        const label = leaf.label ?? leaf.paneType ?? 'terminal';
        const isActive = leaf.id === state.activePaneId;
        return {
          id: leaf.id,
          icon: createElement(TerminalSquare, {
            size: 14,
            className: isActive ? 'text-green-400' : 'text-neutral-500'
          }),
          title: label,
          subtitle: leaf.cwd.replace(window.fleet.homeDir, '~'),
          meta: isActive ? 'active' : undefined,
          data: { paneId: leaf.id, cwd: leaf.cwd, paneType: leaf.paneType ?? 'terminal' }
        };
      });
    },

    renderPreview: (item: TelescopeItem) => {
      // TelescopeModal renders pane info (label, cwd, type)
      return null;
    },

    onSelect: (item: TelescopeItem) => {
      const paneId = item.data?.paneId as string;
      if (paneId) {
        useWorkspaceStore.getState().setActivePane(paneId);
        document.dispatchEvent(
          new CustomEvent('fleet:refocus-pane', { detail: { paneId } })
        );
      }
    }
  };
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/modes/panes-mode.ts
git commit -m "feat(telescope): add Panes mode — switch between open terminal panes"
```

---

### Task 10: TelescopeModal Shell Component

**Files:**
- Create: `src/renderer/src/components/Telescope/TelescopeModal.tsx`

This is the main modal shell — layout, mode tabs, keyboard nav, preview panel. It delegates search/actions to the active mode.

- [ ] **Step 1: Create the modal component**

```typescript
// src/renderer/src/components/Telescope/TelescopeModal.tsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useWorkspaceStore } from '../../store/workspace-store';
import { createFilesMode } from './modes/files-mode';
import { createGrepMode } from './modes/grep-mode';
import { createBrowseMode } from './modes/browse-mode';
import { createPanesMode } from './modes/panes-mode';
import type { TelescopeMode, TelescopeItem } from './types';

type TelescopeModalProps = {
  isOpen: boolean;
  onClose: () => void;
  cwd: string;
};

const MODE_IDS = ['files', 'grep', 'browse', 'panes'] as const;

export function TelescopeModal({ isOpen, onClose, cwd }: TelescopeModalProps): React.JSX.Element | null {
  const [activeModeId, setActiveModeId] = useState<string>('files');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TelescopeItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);

  // Force re-render when browse mode state changes
  const [, forceUpdate] = useState(0);
  const triggerUpdate = useCallback(() => forceUpdate((n) => n + 1), []);

  // Create modes (memoized per cwd/paneId)
  const modes = useMemo((): Record<string, TelescopeMode> => {
    if (!isOpen) return {};
    return {
      files: createFilesMode(cwd, activePaneId),
      grep: createGrepMode(cwd, activePaneId),
      browse: createBrowseMode(cwd, activePaneId, triggerUpdate),
      panes: createPanesMode()
    };
  }, [isOpen, cwd, activePaneId, triggerUpdate]);

  const activeMode = modes[activeModeId];

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setActiveModeId('files');
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setPreviewContent(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Run search when query or mode changes
  useEffect(() => {
    if (!isOpen || !activeMode) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);

    const delay = activeModeId === 'grep' ? 300 : 50;

    debounceRef.current = setTimeout(() => {
      const result = activeMode.onSearch(query);
      if (result instanceof Promise) {
        void result.then((items) => {
          setResults(items);
          setSelectedIndex(0);
        });
      } else {
        setResults(result);
        setSelectedIndex(0);
      }
    }, delay);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, query, activeModeId, activeMode]);

  // Load preview for selected item
  useEffect(() => {
    if (!isOpen || results.length === 0) {
      setPreviewContent(null);
      return;
    }

    const item = results[selectedIndex];
    if (!item) return;

    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);

    previewDebounceRef.current = setTimeout(() => {
      const filePath = item.data?.filePath as string | undefined;
      const isDirectory = item.data?.isDirectory as boolean | undefined;
      const paneId = item.data?.paneId as string | undefined;

      if (paneId) {
        // Panes mode — show pane info
        const paneType = item.data?.paneType as string;
        const paneCwd = item.data?.cwd as string;
        setPreviewContent(`Pane: ${item.title}\nType: ${paneType}\nCWD: ${paneCwd}`);
        setPreviewLoading(false);
      } else if (isDirectory && filePath) {
        // Browse mode directory — show directory listing
        setPreviewLoading(true);
        void window.fleet.file.readdir(filePath).then((res) => {
          if (res.success) {
            const listing = res.entries
              .sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
              })
              .map((e) => (e.isDirectory ? `📁 ${e.name}/` : `   ${e.name}`))
              .join('\n');
            setPreviewContent(listing || '(empty directory)');
          } else {
            setPreviewContent('(unable to read directory)');
          }
          setPreviewLoading(false);
        });
      } else if (filePath) {
        // File — show contents
        setPreviewLoading(true);
        void window.fleet.file.read(filePath).then((res) => {
          if (res.success) {
            // Show first 200 lines
            const lines = res.data.content.split('\n').slice(0, 200);
            const highlightLine = item.data?.line as number | undefined;
            const numbered = lines.map((line, i) => {
              const lineNum = String(i + 1).padStart(4, ' ');
              const marker = highlightLine === i + 1 ? '>' : ' ';
              return `${marker}${lineNum} │ ${line}`;
            });
            setPreviewContent(numbered.join('\n'));
          } else {
            setPreviewContent('(unable to read file)');
          }
          setPreviewLoading(false);
        });
      } else {
        setPreviewContent(null);
      }
    }, 100);

    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
  }, [isOpen, results, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const child = listRef.current?.querySelector(`[data-result-index="${selectedIndex}"]`);
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback(() => {
    const item = results[selectedIndex];
    if (item && activeMode) {
      activeMode.onSelect(item);
      // Don't close for browse mode directory navigation
      if (activeModeId === 'browse' && item.data?.isDirectory) return;
      onClose();
    }
  }, [results, selectedIndex, activeMode, activeModeId, onClose]);

  const handleAltSelect = useCallback(() => {
    const item = results[selectedIndex];
    if (item && activeMode?.onAltSelect) {
      activeMode.onAltSelect(item);
      onClose();
    }
  }, [results, selectedIndex, activeMode, onClose]);

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    const isMod = e.metaKey || e.ctrlKey;

    // Mode switching: Cmd/Ctrl + 1-4
    if (isMod && e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      const modeId = MODE_IDS[parseInt(e.key, 10) - 1];
      if (modeId) {
        setActiveModeId(modeId);
        setQuery('');
      }
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      handleAltSelect();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleSelect();
    } else if (e.key === 'Backspace' && !query && activeModeId === 'browse' && activeMode?.onNavigateUp) {
      e.preventDefault();
      activeMode.onNavigateUp();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen || !activeMode) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[10vh] w-[800px] max-h-[70vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header: search input + mode tabs */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <Search size={14} className="text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={activeMode.placeholder}
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          {/* Mode tabs */}
          <div className="flex items-center gap-0.5 ml-2">
            {MODE_IDS.map((modeId, i) => {
              const mode = modes[modeId];
              if (!mode) return null;
              const Icon = mode.icon;
              const isActive = modeId === activeModeId;
              return (
                <Tooltip.Provider key={modeId} delayDuration={300}>
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <button
                        onClick={() => { setActiveModeId(modeId); setQuery(''); }}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${
                          isActive
                            ? 'bg-neutral-700 text-neutral-200'
                            : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'
                        }`}
                      >
                        <Icon size={12} />
                        {mode.label}
                      </button>
                    </Tooltip.Trigger>
                    <Tooltip.Portal>
                      <Tooltip.Content
                        side="bottom"
                        sideOffset={6}
                        className="px-2 py-1 text-xs text-white bg-neutral-800 border border-neutral-700 rounded shadow-lg z-50"
                      >
                        {window.fleet.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+{i + 1}
                        <Tooltip.Arrow className="fill-neutral-800" />
                      </Tooltip.Content>
                    </Tooltip.Portal>
                  </Tooltip.Root>
                </Tooltip.Provider>
              );
            })}
          </div>
        </div>

        {/* Breadcrumbs (Browse mode only) */}
        {activeModeId === 'browse' && activeMode.breadcrumbs && (
          <div className="px-3 py-1 border-b border-neutral-800 flex items-center gap-1 text-xs text-neutral-500 overflow-x-auto">
            {activeMode.breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1 shrink-0">
                {i > 0 && <span className="text-neutral-700">/</span>}
                <button
                  onClick={() => {
                    // Navigate to the breadcrumb path
                    const crumbs = activeMode.breadcrumbs!;
                    let path: string;
                    if (crumbs[0] === '~') {
                      if (i === 0) path = window.fleet.homeDir;
                      else path = window.fleet.homeDir + '/' + crumbs.slice(1, i + 1).join('/');
                    } else {
                      path = '/' + crumbs.slice(0, i + 1).join('/');
                    }
                    activeMode.onNavigate?.(path);
                  }}
                  className="hover:text-neutral-300 transition-colors"
                >
                  {crumb}
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Body: results + preview */}
        <div className="flex flex-1 min-h-0">
          {/* Results column */}
          <div ref={listRef} className="w-[40%] overflow-y-auto border-r border-neutral-800 py-1">
            {results.length === 0 ? (
              <div className="px-3 py-8 text-sm text-neutral-500 text-center">
                {query ? 'No results' : activeModeId === 'grep' ? 'Type to search file contents...' : 'No items'}
              </div>
            ) : (
              results.map((item, i) => (
                <button
                  key={item.id}
                  data-result-index={i}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                    i === selectedIndex
                      ? 'bg-neutral-700 text-white'
                      : 'text-neutral-300 hover:bg-neutral-800'
                  }`}
                  onMouseEnter={() => setSelectedIndex(i)}
                  onClick={() => {
                    setSelectedIndex(i);
                    handleSelect();
                  }}
                >
                  <span className="shrink-0">{item.icon}</span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate font-medium text-[13px]">{item.title}</span>
                    {item.subtitle && (
                      <span className="truncate text-[11px] text-neutral-500">{item.subtitle}</span>
                    )}
                  </div>
                  {item.meta && (
                    <span className="text-[10px] text-neutral-600 shrink-0">{item.meta}</span>
                  )}
                </button>
              ))
            )}
          </div>

          {/* Preview column */}
          <div className="w-[60%] overflow-auto p-3">
            {previewLoading ? (
              <div className="text-sm text-neutral-500 text-center py-8">Loading preview...</div>
            ) : previewContent ? (
              <pre className="text-[12px] leading-5 text-neutral-400 font-mono whitespace-pre overflow-x-auto">
                {previewContent}
              </pre>
            ) : (
              <div className="text-sm text-neutral-600 text-center py-8">No preview available</div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
          <span>↑↓ navigate</span>
          <span>↵ {activeModeId === 'panes' ? 'focus' : 'open'}</span>
          {activeModeId !== 'panes' && <span>⇧↵ paste path</span>}
          {activeModeId === 'browse' && <span>⌫ up dir</span>}
          <span>esc dismiss</span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/Telescope/TelescopeModal.tsx
git commit -m "feat(telescope): add TelescopeModal shell with two-column layout and mode switching"
```

---

### Task 11: Wire into App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add import**

Add at the top of `App.tsx` alongside the other overlay imports:

```typescript
import { TelescopeModal } from './components/Telescope/TelescopeModal';
```

- [ ] **Step 2: Add state**

Add alongside the other overlay state declarations (near line 122):

```typescript
  const [telescopeOpen, setTelescopeOpen] = useState(false);
```

- [ ] **Step 3: Add event listener**

Add alongside the other toggle event listeners (after the clipboard-history listener, ~line 219):

```typescript
  // Telescope modal toggle (Cmd+Shift+T)
  useEffect(() => {
    const handler = (): void => setTelescopeOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-telescope', handler);
    return () => document.removeEventListener('fleet:toggle-telescope', handler);
  }, []);
```

- [ ] **Step 4: Render the component**

Add alongside the other overlay renders (after `ClipboardHistoryOverlay`):

```typescript
      <TelescopeModal
        isOpen={telescopeOpen}
        onClose={() => setTelescopeOpen(false)}
        cwd={focusedPaneCwd}
      />
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(telescope): wire TelescopeModal into App.tsx with event listener"
```

---

### Task 12: Add Toolbar Button & Event Dispatching

**Files:**
- Modify: `src/renderer/src/components/PaneToolbar.tsx`
- Modify: `src/renderer/src/components/TerminalPane.tsx`

- [ ] **Step 1: Add Telescope icon import and prop to PaneToolbar**

In `src/renderer/src/components/PaneToolbar.tsx`:

Add `Telescope` to the lucide-react import on line 1:

```typescript
import { Columns2, Rows2, Search, X, GitBranch, FileSearch, Clipboard, BookOpen, Crosshair, Telescope } from 'lucide-react';
```

Add `onTelescope` to the `PaneToolbarProps` type (after `onAnnotate` on line 40):

```typescript
  onTelescope?: () => void;
```

Add `onTelescope` to the destructured props (after `onAnnotate` on line 54):

```typescript
  onTelescope
```

- [ ] **Step 2: Add the Telescope button**

In `PaneToolbar.tsx`, add the Telescope button after the `onAnnotate` block (after line 148) and before the Search in Pane button:

```typescript
        {onTelescope && (
          <ToolbarTooltip label={`Telescope (${formatShortcut(getShortcut('telescope')!)})`}>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onTelescope();
              }}
              className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
            >
              <Telescope size={14} />
            </button>
          </ToolbarTooltip>
        )}
```

- [ ] **Step 3: Wire event in TerminalPane**

In `src/renderer/src/components/TerminalPane.tsx`, add the `onTelescope` prop to the `PaneToolbar` render (around line 142, after `onAnnotate`):

```typescript
        onTelescope={() => document.dispatchEvent(new CustomEvent('fleet:toggle-telescope'))}
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/PaneToolbar.tsx src/renderer/src/components/TerminalPane.tsx
git commit -m "feat(telescope): add Telescope button to pane toolbar"
```

---

### Task 13: Keyboard Shortcut Handler

**Files:**
- Modify: `src/renderer/src/App.tsx` (the global keydown handler)

Check how existing shortcuts dispatch their events — likely a global keydown listener.

- [ ] **Step 1: Find the global keydown handler**

Look for where `matchesShortcut` is called in `App.tsx` or a related hook. The telescope shortcut needs to dispatch `fleet:toggle-telescope` when `Cmd+Shift+T` is pressed.

Search for the existing shortcut dispatch pattern and add:

```typescript
    if (matchesShortcut(e, getShortcut('telescope')!)) {
      e.preventDefault();
      document.dispatchEvent(new CustomEvent('fleet:toggle-telescope'));
    }
```

This should be added in the same keydown handler where other shortcuts like `quick-open`, `file-search`, and `clipboard-history` are handled.

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(telescope): add Cmd+Shift+T keyboard shortcut handler"
```

---

### Task 14: Manual Testing & Polish

**Files:**
- No new files — testing and fixing issues found.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test opening the telescope**

1. Hover over a pane — verify the Telescope icon appears in the toolbar
2. Click it — verify the modal opens centered with the two-column layout
3. Press `Cmd+Shift+T` — verify the modal toggles
4. Press `Escape` — verify it closes
5. Click the backdrop — verify it closes

- [ ] **Step 3: Test Files mode**

1. Open telescope — should default to Files mode
2. Empty query should show recent files
3. Type a filename — verify fuzzy matching works
4. Arrow keys should navigate, selected item should highlight
5. Preview panel should show file contents for selected item
6. Press Enter — should open file in a viewer tab
7. Press Shift+Enter — should paste the path into the terminal

- [ ] **Step 4: Test Grep mode**

1. Press `Cmd+2` to switch to Grep mode
2. Type a search term that exists in files in the cwd
3. Results should show file:line with matching text
4. Preview should show file contents scrolled to the matching line
5. If `rg` is not installed, fallback to `grep` should work

- [ ] **Step 5: Test Browse mode**

1. Press `Cmd+3` to switch to Browse mode
2. Should show directory listing of the pane's cwd
3. Directories should be listed first
4. Click a directory — should drill in, breadcrumbs should update
5. Click a breadcrumb — should navigate back
6. Press Backspace on empty query — should go up one directory
7. Type to filter the current directory listing
8. Enter on a file — should open in viewer
9. Enter on a directory — should drill in

- [ ] **Step 6: Test Panes mode**

1. Split into multiple panes first
2. Press `Cmd+4` to switch to Panes mode
3. Should list all open panes with their labels and cwds
4. Active pane should be marked
5. Enter on a pane — should focus that pane and close the modal

- [ ] **Step 7: Fix any issues found and commit**

```bash
git add -A
git commit -m "fix(telescope): polish and fixes from manual testing"
```

- [ ] **Step 8: Final verification**

Run: `npm run build`
Expected: Build succeeds with no errors.
