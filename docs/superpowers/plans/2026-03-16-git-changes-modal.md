# Git Changes Modal Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only git changes modal showing full diffs with syntax highlighting for the focused pane's working directory.

**Architecture:** Main process runs git operations via `simple-git`, exposes two IPC channels (`GIT_IS_REPO`, `GIT_STATUS`). Renderer renders diffs using `@git-diff-view/react` + `@git-diff-view/shiki` in a near-full-screen modal with a file list sidebar. Triggered by `Cmd+Shift+G` or pane toolbar button.

**Tech Stack:** simple-git, @git-diff-view/react, @git-diff-view/shiki, shiki, React, Zustand, Tailwind CSS, lucide-react

**Spec:** `docs/superpowers/specs/2026-03-16-git-changes-modal-design.md`

---

## File Structure

**New files:**
- `src/main/git-service.ts` — Git operations module (`checkIsRepo`, `getFullStatus`)
- `src/main/__tests__/git-service.test.ts` — Unit tests for git-service
- `src/renderer/src/components/GitChangesModal.tsx` — Modal component with file sidebar + diff viewer

**Modified files:**
- `src/shared/constants.ts` — Add `GIT_IS_REPO` and `GIT_STATUS` IPC channels
- `src/shared/ipc-api.ts` — Add `GitStatusPayload` and `GitIsRepoPayload` types
- `src/preload/index.ts` — Add `git.isRepo` and `git.getStatus` bridge methods
- `src/main/ipc-handlers.ts` — Register git IPC handlers
- `src/renderer/src/lib/shortcuts.ts` — Add `git-changes` shortcut definition
- `src/renderer/src/lib/commands.ts` — Add git changes command to palette
- `src/renderer/src/hooks/use-pane-navigation.ts` — Handle `fleet:toggle-git-changes` event dispatch
- `src/renderer/src/components/PaneToolbar.tsx` — Add git icon button
- `src/renderer/src/App.tsx` — Mount `GitChangesModal` + toggle state

---

## Chunk 1: Backend — IPC Types, Git Service, Handlers

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install simple-git (main process dependency)**

```bash
npm install simple-git
```

- [ ] **Step 2: Install diff viewer and syntax highlighting (renderer dependencies)**

```bash
npm install @git-diff-view/react @git-diff-view/shiki shiki
```

- [ ] **Step 3: Verify dependencies installed correctly**

```bash
npm ls simple-git @git-diff-view/react @git-diff-view/shiki shiki
```

Expected: All four packages listed without errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add simple-git, @git-diff-view/react, @git-diff-view/shiki, shiki"
```

---

### Task 2: Add IPC channel constants and types

**Files:**
- Modify: `src/shared/constants.ts:5-23`
- Modify: `src/shared/ipc-api.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/constants.ts`, add two new channels to the `IPC_CHANNELS` object (after `SETTINGS_SET`):

```typescript
  GIT_IS_REPO: 'git:is-repo',
  GIT_STATUS: 'git:status',
```

- [ ] **Step 2: Add IPC payload types**

In `src/shared/ipc-api.ts`, add at the end of the file:

```typescript
export type GitFileStatus = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
  insertions: number;
  deletions: number;
};

export type GitStatusPayload = {
  isRepo: boolean;
  branch: string;
  files: GitFileStatus[];
  diff: string;
  error?: string;
};

export type GitIsRepoPayload = {
  isRepo: boolean;
};
```

- [ ] **Step 3: Verify types compile**

```bash
npm run typecheck:node
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/constants.ts src/shared/ipc-api.ts
git commit -m "feat: add GIT_IS_REPO and GIT_STATUS IPC channel types"
```

---

### Task 3: Implement git-service.ts

**Files:**
- Create: `src/main/git-service.ts`
- Test: `src/main/__tests__/git-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/__tests__/git-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitService } from '../git-service';

// Mock simple-git
const mockGit = {
  checkIsRepo: vi.fn(),
  branch: vi.fn(),
  status: vi.fn(),
  diff: vi.fn(),
  raw: vi.fn(),
};

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => mockGit),
}));

describe('GitService', () => {
  let service: GitService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GitService();
  });

  describe('checkIsRepo', () => {
    it('returns true when inside a git repo', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      const result = await service.checkIsRepo('/some/repo');
      expect(result).toEqual({ isRepo: true });
    });

    it('returns false when not inside a git repo', async () => {
      mockGit.checkIsRepo.mockResolvedValue(false);
      const result = await service.checkIsRepo('/not/a/repo');
      expect(result).toEqual({ isRepo: false });
    });

    it('returns false when git throws', async () => {
      mockGit.checkIsRepo.mockRejectedValue(new Error('git not found'));
      const result = await service.checkIsRepo('/some/path');
      expect(result).toEqual({ isRepo: false });
    });
  });

  describe('getFullStatus', () => {
    it('returns not-a-repo payload when not in a repo', async () => {
      mockGit.checkIsRepo.mockResolvedValue(false);
      const result = await service.getFullStatus('/not/a/repo');
      expect(result).toEqual({
        isRepo: false,
        branch: '',
        files: [],
        diff: '',
      });
    });

    it('returns full status for a repo with changes', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.branch.mockResolvedValue({ current: 'main' });
      mockGit.status.mockResolvedValue({
        files: [
          { path: 'src/app.ts', index: ' ', working_dir: 'M' },
          { path: 'new-file.ts', index: '?', working_dir: '?' },
        ],
        not_added: ['new-file.ts'],
      });
      mockGit.diff.mockResolvedValue('diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n');
      // diffSummary for tracked files
      mockGit.raw.mockImplementation((args: string[]) => {
        if (args.includes('--numstat') && !args.includes('--no-index')) {
          return Promise.resolve('3\t1\tsrc/app.ts\n');
        }
        // For untracked file diff
        if (args.includes('--no-index')) {
          return Promise.resolve('diff --git a/new-file.ts b/new-file.ts\nnew file\n--- /dev/null\n+++ b/new-file.ts\n@@ -0,0 +1 @@\n+content\n');
        }
        return Promise.resolve('');
      });

      const result = await service.getFullStatus('/some/repo');

      expect(result.isRepo).toBe(true);
      expect(result.branch).toBe('main');
      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({ path: 'src/app.ts', status: 'modified' });
      expect(result.files[1]).toMatchObject({ path: 'new-file.ts', status: 'untracked' });
      expect(result.diff).toContain('diff --git');
      expect(result.error).toBeUndefined();
    });

    it('returns error payload when git operation fails', async () => {
      mockGit.checkIsRepo.mockResolvedValue(true);
      mockGit.branch.mockRejectedValue(new Error('fatal: corrupted repo'));

      const result = await service.getFullStatus('/broken/repo');

      expect(result.isRepo).toBe(true);
      expect(result.error).toBe('fatal: corrupted repo');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/main/__tests__/git-service.test.ts
```

Expected: FAIL — module `../git-service` not found.

- [ ] **Step 3: Implement git-service.ts**

Create `src/main/git-service.ts`:

```typescript
import { simpleGit, type SimpleGit, type FileStatusResult } from 'simple-git';
import type { GitStatusPayload, GitIsRepoPayload, GitFileStatus } from '../shared/ipc-api';

export class GitService {
  private getGit(cwd: string): SimpleGit {
    return simpleGit({ baseDir: cwd });
  }

  async checkIsRepo(cwd: string): Promise<GitIsRepoPayload> {
    try {
      const isRepo = await this.getGit(cwd).checkIsRepo();
      return { isRepo };
    } catch {
      return { isRepo: false };
    }
  }

  async getFullStatus(cwd: string): Promise<GitStatusPayload> {
    const git = this.getGit(cwd);

    // Check if it's a repo first
    try {
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        return { isRepo: false, branch: '', files: [], diff: '' };
      }
    } catch {
      return { isRepo: false, branch: '', files: [], diff: '' };
    }

    try {
      const [branchInfo, statusResult] = await Promise.all([
        git.branch(),
        git.status(),
      ]);

      const branch = branchInfo.current;
      const untrackedPaths = new Set(statusResult.not_added);

      // Get numstat for tracked file stats
      let numstatRaw = '';
      const hasTrackedChanges = statusResult.files.some(
        (f) => !untrackedPaths.has(f.path),
      );
      if (hasTrackedChanges) {
        numstatRaw = await git.raw(['diff', 'HEAD', '--numstat']);
      }

      // Parse numstat: "insertions\tdeletions\tpath"
      const numstatMap = new Map<string, { insertions: number; deletions: number }>();
      for (const line of numstatRaw.split('\n')) {
        const parts = line.split('\t');
        if (parts.length === 3) {
          numstatMap.set(parts[2], {
            insertions: parseInt(parts[0]) || 0,
            deletions: parseInt(parts[1]) || 0,
          });
        }
      }

      // Build file list
      const files: GitFileStatus[] = statusResult.files.map((f) => {
        const isUntracked = untrackedPaths.has(f.path);
        const stats = numstatMap.get(f.path) || { insertions: 0, deletions: 0 };
        return {
          path: f.path,
          status: resolveStatus(f, isUntracked),
          insertions: stats.insertions,
          deletions: stats.deletions,
        };
      });

      // Get unified diff for tracked files
      let diff = '';
      if (hasTrackedChanges) {
        diff = await git.diff(['HEAD']);
      }

      // Append diffs for untracked files
      for (const path of untrackedPaths) {
        try {
          const untrackedDiff = await git.raw([
            'diff',
            '--no-index',
            '/dev/null',
            path,
          ]);
          diff += untrackedDiff;
        } catch (e: unknown) {
          // git diff --no-index exits with code 1 when files differ (which is always
          // the case for /dev/null vs a real file). simple-git throws on non-zero exit.
          // The stderr/stdout still contains the diff, so extract it from the error.
          if (e && typeof e === 'object' && 'message' in e) {
            const msg = (e as { message: string }).message;
            // Extract the actual diff output from the error message
            const diffMatch = msg.match(/(diff --git[\s\S]*)/);
            if (diffMatch) {
              diff += diffMatch[1];
            }
          }
        }
      }

      return { isRepo: true, branch, files, diff };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { isRepo: true, branch: '', files: [], diff: '', error: message };
    }
  }
}

function resolveStatus(
  file: FileStatusResult,
  isUntracked: boolean,
): GitFileStatus['status'] {
  if (isUntracked) return 'untracked';
  // Check both index and working_dir status
  const combined = file.index + file.working_dir;
  if (combined.includes('R')) return 'renamed';
  if (combined.includes('A')) return 'added';
  if (combined.includes('D')) return 'deleted';
  return 'modified';
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/main/__tests__/git-service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/git-service.ts src/main/__tests__/git-service.test.ts
git commit -m "feat: add git-service module with checkIsRepo and getFullStatus"
```

---

### Task 4: Register IPC handlers and preload bridge

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add GitService import and parameter to registerIpcHandlers**

In `src/main/ipc-handlers.ts`:

1. Add import at top:
```typescript
import { GitService } from './git-service';
```

2. Add `gitService: GitService` parameter to the `registerIpcHandlers` function signature (after `cwdPoller`):
```typescript
export function registerIpcHandlers(
  ptyManager: PtyManager,
  layoutStore: LayoutStore,
  eventBus: EventBus,
  notificationDetector: NotificationDetector,
  notificationState: NotificationStateManager,
  settingsStore: SettingsStore,
  cwdPoller: CwdPoller,
  gitService: GitService,
  getWindow: () => BrowserWindow | null,
): void {
```

3. Add handlers at the end of the function body (before the closing `}`):
```typescript
  // Git handlers
  ipcMain.handle(IPC_CHANNELS.GIT_IS_REPO, (_event, cwd: string) => {
    return gitService.checkIsRepo(cwd);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_event, cwd: string) => {
    return gitService.getFullStatus(cwd);
  });
```

- [ ] **Step 2: Update the caller in index.ts to pass GitService**

Find where `registerIpcHandlers` is called in `src/main/index.ts` and add a `new GitService()` argument. First read the file to find the exact call site:

```bash
grep -n 'registerIpcHandlers' src/main/index.ts
```

Then add the import and pass the instance. The import:
```typescript
import { GitService } from './git-service';
```

Create the instance near other service instantiations (before `app.whenReady`):
```typescript
const gitService = new GitService();
```

Update the call at line 103 from:
```typescript
registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, notificationState, settingsStore, cwdPoller, () => mainWindow);
```
to:
```typescript
registerIpcHandlers(ptyManager, layoutStore, eventBus, notificationDetector, notificationState, settingsStore, cwdPoller, gitService, () => mainWindow);
```

- [ ] **Step 3: Add preload bridge methods**

In `src/preload/index.ts`:

1. Add imports for the new types (add to existing import):
```typescript
import type {
  // ... existing imports ...
  GitStatusPayload,
  GitIsRepoPayload,
} from '../shared/ipc-api';
```

2. Add `git` namespace to the `fleetApi` object (after `updates`):
```typescript
  git: {
    isRepo: (cwd: string): Promise<GitIsRepoPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_IS_REPO, cwd),
    getStatus: (cwd: string): Promise<GitStatusPayload> =>
      ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, cwd),
  },
```

- [ ] **Step 4: Verify types compile**

```bash
npm run typecheck
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/index.ts src/preload/index.ts
git commit -m "feat: register git IPC handlers and preload bridge"
```

---

## Chunk 2: Frontend — Shortcut, Toolbar Button, Modal Component

### Task 5: Add keyboard shortcut and command palette entry

**Files:**
- Modify: `src/renderer/src/lib/shortcuts.ts:21-106`
- Modify: `src/renderer/src/lib/commands.ts:17-95`
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts:14-122`

- [ ] **Step 1: Add shortcut definition**

In `src/renderer/src/lib/shortcuts.ts`, add to the `ALL_SHORTCUTS` array (after the `command-palette` entry, before the closing `]`):

```typescript
  {
    id: 'git-changes',
    label: 'Git Changes',
    mac: { key: 'g', meta: true, shift: true },
    other: { key: 'G', ctrl: true, shift: true },
  },
```

- [ ] **Step 2: Add command palette entry**

In `src/renderer/src/lib/commands.ts`, add to the array returned by `createCommandRegistry()` (before the closing `]`):

```typescript
    {
      id: 'git-changes',
      label: 'Git Changes',
      shortcut: sc('git-changes'),
      category: 'View',
      execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes')),
    },
```

- [ ] **Step 3: Add shortcut handler in use-pane-navigation**

In `src/renderer/src/hooks/use-pane-navigation.ts`, add a handler inside `handleKeyDown` (after the `command-palette` handler, before the `Cmd/Ctrl+1-9` section):

```typescript
      if (matchesShortcut(e, sc('git-changes'))) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'));
        return;
      }
```

- [ ] **Step 4: Verify types compile**

```bash
npm run typecheck:web
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/shortcuts.ts src/renderer/src/lib/commands.ts src/renderer/src/hooks/use-pane-navigation.ts
git commit -m "feat: add Cmd+Shift+G shortcut and command palette entry for git changes"
```

---

### Task 6: Add git icon button to PaneToolbar

**Files:**
- Modify: `src/renderer/src/components/PaneToolbar.tsx`

- [ ] **Step 1: Add GitBranch icon import and onGitChanges prop**

In `src/renderer/src/components/PaneToolbar.tsx`:

1. Add `GitBranch` to the lucide-react import:
```typescript
import { Columns2, Rows2, Search, X, GitBranch } from 'lucide-react';
```

2. Add `isGitRepo` and `onGitChanges` to the props type:
```typescript
type PaneToolbarProps = {
  visible: boolean;
  isGitRepo: boolean;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onClose: () => void;
  onSearch: () => void;
  onGitChanges: () => void;
};
```

3. Update the function signature to destructure the new props:
```typescript
export function PaneToolbar({ visible, isGitRepo, onSplitHorizontal, onSplitVertical, onClose, onSearch, onGitChanges }: PaneToolbarProps) {
```

4. Add the git button (before the Search button):
```typescript
      {isGitRepo && (
        <button
          onClick={(e) => { e.stopPropagation(); onGitChanges(); }}
          className="p-1 text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          title={`Git Changes (${formatShortcut(getShortcut('git-changes')!)})`}
        >
          <GitBranch size={14} />
        </button>
      )}
```

- [ ] **Step 2: Update PaneToolbar usage in TerminalPane**

Read `src/renderer/src/components/TerminalPane.tsx` to find where `PaneToolbar` is rendered, then update it to pass the new props. You'll need to:

1. Import `useCwdStore` and add a `useEffect` to check git repo status:

```typescript
import { useCwdStore } from '../store/cwd-store';
```

2. Inside the component, add state for isGitRepo and check on CWD change:

```typescript
const [isGitRepo, setIsGitRepo] = useState(false);
const cwd = useCwdStore((s) => s.cwds.get(paneId));

useEffect(() => {
  if (!cwd) {
    setIsGitRepo(false);
    return;
  }
  window.fleet.git.isRepo(cwd).then((result) => {
    setIsGitRepo(result.isRepo);
  });
}, [cwd]);
```

3. Pass the new props to `PaneToolbar`:

```typescript
<PaneToolbar
  visible={...}
  isGitRepo={isGitRepo}
  onSplitHorizontal={...}
  onSplitVertical={...}
  onClose={...}
  onSearch={...}
  onGitChanges={() => document.dispatchEvent(new CustomEvent('fleet:toggle-git-changes'))}
/>
```

- [ ] **Step 3: Verify types compile**

```bash
npm run typecheck:web
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/PaneToolbar.tsx src/renderer/src/components/TerminalPane.tsx
git commit -m "feat: add git branch icon button to pane toolbar"
```

---

### Task 7: Create GitChangesModal component

**Files:**
- Create: `src/renderer/src/components/GitChangesModal.tsx`

This is the largest task. The component includes:
- Near-full-screen overlay with scrim
- Header bar (branch, stats, unified/split toggle, close)
- File list sidebar with filter
- Diff content area using `@git-diff-view/react`
- Loading, error, empty, and no-CWD states
- Keyboard navigation

- [ ] **Step 1: Create the modal component**

Create `src/renderer/src/components/GitChangesModal.tsx`:

```tsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X, Loader2, GitBranch, AlertCircle } from 'lucide-react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import { DiffFile } from '@git-diff-view/react';
import '@git-diff-view/react/styles/diff-view.css';
import type { GitStatusPayload, GitFileStatus } from '../../../shared/ipc-api';

type GitChangesModalProps = {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
};

export function GitChangesModal({ isOpen, onClose, cwd }: GitChangesModalProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<GitStatusPayload | null>(null);
  const [filterText, setFilterText] = useState('');
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);
  const modalRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const fileListRef = useRef<HTMLDivElement>(null);
  const diffContainerRef = useRef<HTMLDivElement>(null);

  // Scroll diff pane to a specific file's section
  const scrollToFile = useCallback((filePath: string | undefined) => {
    if (!filePath || !diffContainerRef.current) return;
    const el = diffContainerRef.current.querySelector(`[data-file-path="${CSS.escape(filePath)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Fetch git status when modal opens
  useEffect(() => {
    if (!isOpen || !cwd) return;
    setLoading(true);
    setData(null);
    setFilterText('');
    setActiveFileIndex(0);
    window.fleet.git.getStatus(cwd).then((result) => {
      setData(result);
      setLoading(false);
    });
  }, [isOpen, cwd]);

  // Filter files
  const filteredFiles = useMemo(() => {
    if (!data?.files) return [];
    if (!filterText) return data.files;
    const lower = filterText.toLowerCase();
    return data.files.filter((f) => f.path.toLowerCase().includes(lower));
  }, [data?.files, filterText]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      // Escape always closes
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // q closes (only when not typing)
      if (e.key === 'q' && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // / focuses filter (only when not typing)
      if (e.key === '/' && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        filterInputRef.current?.focus();
        return;
      }

      // j/k or ArrowUp/ArrowDown navigate file list (only when not typing)
      if ((e.key === 'j' || e.key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        const down = e.key === 'j' || e.key === 'ArrowDown';
        setActiveFileIndex((prev) => {
          const next = down ? Math.min(prev + 1, filteredFiles.length - 1) : Math.max(prev - 1, 0);
          // Scroll to the file's diff section
          scrollToFile(filteredFiles[next]?.path);
          return next;
        });
        return;
      }

      // Enter jumps to active file's diff
      if (e.key === 'Enter' && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        const activeFile = filteredFiles[activeFileIndex];
        if (activeFile) scrollToFile(activeFile.path);
        return;
      }

      // n/p jump to next/previous file in diff pane (only when not typing)
      if ((e.key === 'n' || e.key === 'p') && !isInputFocused) {
        e.preventDefault();
        e.stopPropagation();
        setActiveFileIndex((prev) => {
          const next = e.key === 'n'
            ? Math.min(prev + 1, filteredFiles.length - 1)
            : Math.max(prev - 1, 0);
          scrollToFile(filteredFiles[next]?.path);
          return next;
        });
        return;
      }

      // Intercept Cmd+F / Ctrl+F for in-modal search (prevent global shortcut)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.stopPropagation();
        filterInputRef.current?.focus();
        return;
      }
    },
    [onClose, filteredFiles, activeFileIndex],
  );

  if (!isOpen) return null;

  // State: No CWD
  if (!cwd) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<AlertCircle size={32} />} message="Working directory not available" onClose={onClose} />
      </ModalShell>
    );
  }

  // State: Loading
  if (loading) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<Loader2 size={32} className="animate-spin" />} message="Loading changes..." />
      </ModalShell>
    );
  }

  // State: Error
  if (data?.error) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<AlertCircle size={32} className="text-red-400" />} message={data.error} onClose={onClose} />
      </ModalShell>
    );
  }

  // State: Not a repo
  if (data && !data.isRepo) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<GitBranch size={32} />} message="Not a git repository" onClose={onClose} />
      </ModalShell>
    );
  }

  // State: No changes
  if (data && data.files.length === 0) {
    return (
      <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
        <StateMessage icon={<GitBranch size={32} />} message="No changes" onClose={onClose} />
      </ModalShell>
    );
  }

  // State: Full diff view
  const totalInsertions = data?.files.reduce((sum, f) => sum + f.insertions, 0) ?? 0;
  const totalDeletions = data?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0;

  return (
    <ModalShell onClose={onClose} onKeyDown={handleKeyDown} modalRef={modalRef}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 shrink-0">
        <div className="flex items-center gap-3">
          <GitBranch size={16} className="text-neutral-400" />
          <span className="text-sm font-medium text-white">{data?.branch || 'Working Changes'}</span>
          <span className="text-xs text-neutral-500">
            {data?.files.length} file{data?.files.length !== 1 ? 's' : ''} changed
            {totalInsertions > 0 && <span className="text-green-400 ml-2">+{totalInsertions}</span>}
            {totalDeletions > 0 && <span className="text-red-400 ml-1">−{totalDeletions}</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDiffMode(diffMode === DiffModeEnum.Unified ? DiffModeEnum.Split : DiffModeEnum.Unified)}
            className="px-2 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-neutral-700 transition-colors"
          >
            {diffMode === DiffModeEnum.Unified ? 'Split' : 'Unified'}
          </button>
          <button onClick={onClose} className="p-1 text-neutral-500 hover:text-white">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body: sidebar + diff */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* File list sidebar */}
        <div className="w-60 border-r border-neutral-800 flex flex-col shrink-0">
          {/* Filter */}
          <div className="p-2 border-b border-neutral-800">
            <input
              ref={filterInputRef}
              type="text"
              placeholder="Filter files..."
              value={filterText}
              onChange={(e) => { setFilterText(e.target.value); setActiveFileIndex(0); }}
              className="w-full px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded text-white placeholder-neutral-500 outline-none focus:border-neutral-600"
            />
            {filterText && (
              <span className="text-[10px] text-neutral-500 mt-1 block">
                {filteredFiles.length} of {data?.files.length} files
              </span>
            )}
          </div>
          {/* File list */}
          <div ref={fileListRef} className="flex-1 overflow-y-auto">
            {filteredFiles.map((file, i) => (
              <FileEntry
                key={file.path}
                file={file}
                active={i === activeFileIndex}
                onClick={() => { setActiveFileIndex(i); scrollToFile(file.path); }}
              />
            ))}
          </div>
        </div>

        {/* Diff content */}
        <div ref={diffContainerRef} className="flex-1 min-w-0 overflow-auto">
          {data?.diff ? (
            <DiffContent diff={data.diff} diffMode={diffMode} />
          ) : (
            <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
              No diff content
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

// --- Sub-components ---

function ModalShell({
  children,
  onClose,
  onKeyDown,
  modalRef,
}: {
  children: React.ReactNode;
  onClose: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  modalRef: React.RefObject<HTMLDivElement | null>;
}) {
  // Focus trap: focus the modal on open
  useEffect(() => {
    modalRef.current?.focus();
  }, [modalRef]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl flex flex-col outline-none"
        style={{ width: 'calc(100vw - 64px)', height: 'calc(100vh - 48px)' }}
      >
        {children}
      </div>
    </div>
  );
}

function StateMessage({
  icon,
  message,
  onClose,
}: {
  icon: React.ReactNode;
  message: string;
  onClose?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-neutral-500">
      {icon}
      <span className="text-sm">{message}</span>
      {onClose && (
        <button onClick={onClose} className="text-xs text-neutral-600 hover:text-white mt-2">
          Close
        </button>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<GitFileStatus['status'], string> = {
  added: 'text-green-400',
  untracked: 'text-green-400',
  modified: 'text-yellow-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400',
};

const STATUS_LABELS: Record<GitFileStatus['status'], string> = {
  added: 'A',
  untracked: 'U',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

function FileEntry({
  file,
  active,
  onClick,
}: {
  file: GitFileStatus;
  active: boolean;
  onClick: () => void;
}) {
  const parts = file.path.split('/');
  const filename = parts.pop()!;
  const dir = parts.join('/');

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-800 transition-colors flex items-center gap-2 ${active ? 'bg-neutral-800' : ''}`}
    >
      <span className={`font-mono text-[10px] ${STATUS_COLORS[file.status]}`}>
        {STATUS_LABELS[file.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-white truncate">{filename}</div>
        {dir && <div className="text-neutral-500 truncate">{dir}</div>}
      </div>
      <span className="text-[10px] text-neutral-500 shrink-0">
        {file.insertions > 0 && <span className="text-green-400">+{file.insertions}</span>}
        {file.deletions > 0 && <span className="text-red-400 ml-1">−{file.deletions}</span>}
      </span>
    </button>
  );
}

function DiffContent({ diff, diffMode }: { diff: string; diffMode: DiffModeEnum }) {
  // @git-diff-view/react expects DiffFile instances.
  // Parse the raw unified diff into DiffFile objects.
  const [diffFiles, setDiffFiles] = useState<DiffFile[]>([]);

  useEffect(() => {
    if (!diff) {
      setDiffFiles([]);
      return;
    }

    // IMPORTANT: The @git-diff-view/react API for creating DiffFile instances
    // may differ from what's shown here. After installing, check the actual API:
    //   cat node_modules/@git-diff-view/react/dist/index.d.ts | head -200
    //   cat node_modules/@git-diff-view/react/README.md
    // The library may use DiffFile.createInstance(data) with a different data shape,
    // or provide a helper function like `generateDiffFile()` or `parseDiff()`.
    // Adjust the code below to match the actual API.
    try {
      const files = DiffFile.createInstance({}, diff);
      for (const file of files) {
        file.initRaw();
        file.buildSplitDiffLines();
        file.buildUnifiedDiffLines();
      }
      setDiffFiles(files);
    } catch (e) {
      console.error('Failed to parse diff:', e);
      setDiffFiles([]);
    }
  }, [diff]);

  if (diffFiles.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600 text-sm">
        No diff content to display
      </div>
    );
  }

  return (
    <div className="p-2">
      {diffFiles.map((file, i) => (
        <div key={file.fileName || i} className="mb-4" data-file-path={file.fileName}>
          <div className="sticky top-0 z-10 bg-neutral-900 border-b border-neutral-800 px-3 py-1.5 text-xs font-mono text-neutral-300">
            {file.fileName}
          </div>
          <DiffView diffFile={file} diffViewMode={diffMode} diffViewTheme="dark" />
        </div>
      ))}
    </div>
  );
}
```

**Important notes for the implementer:**

1. **@git-diff-view/react API:** The DiffFile creation API may differ from what's shown. Before implementing, check the library's README and types:

```bash
cat node_modules/@git-diff-view/react/README.md 2>/dev/null || true
ls node_modules/@git-diff-view/react/dist/
```

Adjust the `DiffFile` creation and `DiffView` props based on the actual API. The core structure (modal shell, file sidebar, diff content area) is correct — only the diff library integration details may need tweaking.

2. **Shiki syntax highlighting:** The `@git-diff-view/shiki` package provides a highlighter that integrates with `@git-diff-view/react`. After installing, check the integration API:

```bash
cat node_modules/@git-diff-view/shiki/README.md 2>/dev/null || true
cat node_modules/@git-diff-view/shiki/dist/index.d.ts | head -50
```

Typically you create a Shiki highlighter instance and pass it to the `DiffView` component via a `highlighter` prop or a provider. The highlighter should be lazily loaded on first modal open:

```typescript
import { useEffect, useState } from 'react';

// Lazy-load Shiki highlighter on first use
let highlighterPromise: Promise<any> | null = null;

function useShikiHighlighter() {
  const [highlighter, setHighlighter] = useState(null);
  useEffect(() => {
    if (!highlighterPromise) {
      highlighterPromise = import('@git-diff-view/shiki').then(async (mod) => {
        // Create highlighter with limited language set + github-dark theme
        return mod.createShikiHighlighter({ theme: 'github-dark' });
      });
    }
    highlighterPromise.then(setHighlighter);
  }, []);
  return highlighter;
}
```

Then pass the highlighter to `DiffView`. The exact prop name depends on the library version — check types after install.

3. **Additional keyboard features to add during polish (Task 10):** The following spec features should be refined during integration testing:
   - `Tab` key to toggle focus between file list and diff pane
   - `[`/`]` keys for hunk-level navigation within a file
   - Auto-highlight current file in sidebar as user scrolls the diff pane (via IntersectionObserver on file section headers)
   - Collapse/expand per file via clicking the sticky file header
   - Resizable sidebar (drag handle between panels)

These features depend on the actual `@git-diff-view/react` DOM structure and are best implemented after the basic modal is working.

- [ ] **Step 2: Verify types compile**

```bash
npm run typecheck:web
```

If there are type errors related to `@git-diff-view/react` API, read the library's type definitions and adjust:
```bash
cat node_modules/@git-diff-view/react/dist/index.d.ts | head -100
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/GitChangesModal.tsx
git commit -m "feat: create GitChangesModal component with file sidebar and diff viewer"
```

---

### Task 8: Mount modal in App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add imports, state, event listener, and render**

In `src/renderer/src/App.tsx`:

1. Add import for the modal (new line):
```typescript
import { GitChangesModal } from './components/GitChangesModal';
```
And add `useCwdStore` to the existing `cwd-store` import (line 9 already imports `initCwdListener`):
```typescript
import { initCwdListener, useCwdStore } from './store/cwd-store';
```

2. Add state (alongside other modal states, near line 49-51):
```typescript
const [gitChangesOpen, setGitChangesOpen] = useState(false);
```

3. Add CWD lookup for the focused pane (after `settings` const):
```typescript
const focusedPaneCwd = useCwdStore((s) => activePaneId ? s.cwds.get(activePaneId) : undefined);
```

4. Add event listener (alongside other toggle listeners, after the command palette one ~line 83):
```typescript
  // Git changes modal toggle
  useEffect(() => {
    const handler = () => setGitChangesOpen((prev) => !prev);
    document.addEventListener('fleet:toggle-git-changes', handler);
    return () => document.removeEventListener('fleet:toggle-git-changes', handler);
  }, []);
```

5. Render the modal (after `<CommandPalette ... />`, near line 286):
```typescript
      <GitChangesModal isOpen={gitChangesOpen} onClose={() => setGitChangesOpen(false)} cwd={focusedPaneCwd} />
```

- [ ] **Step 2: Verify types compile**

```bash
npm run typecheck:web
```

Expected: No errors.

- [ ] **Step 3: Verify full build**

```bash
npm run build
```

Expected: Build completes successfully.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: mount GitChangesModal in App and wire toggle event"
```

---

## Chunk 3: Integration Testing & Polish

### Task 9: Manual integration test

- [ ] **Step 1: Run the app in dev mode**

```bash
npm run dev
```

- [ ] **Step 2: Test keyboard shortcut**

1. Open a terminal pane and `cd` into a git repo with changes
2. Press `Cmd+Shift+G` (Mac) or `Ctrl+Shift+G`
3. Verify the modal opens with:
   - Branch name in header
   - File list on the left
   - Diff content on the right with syntax highlighting
   - Correct insertion/deletion stats

- [ ] **Step 3: Test states**

1. In a non-git directory, press `Cmd+Shift+G` — should show "Not a git repository"
2. In a clean git repo (no changes), press `Cmd+Shift+G` — should show "No changes"
3. Press `Escape` or `q` — modal should close

- [ ] **Step 4: Test keyboard navigation**

1. With modal open, press `j`/`k` to navigate file list
2. Press `/` to focus the filter input
3. Type to filter files
4. Press `Escape` to close

- [ ] **Step 5: Test toolbar button**

1. Hover over a terminal pane in a git repo
2. Verify the git branch icon appears in the toolbar
3. Click it — modal should open
4. In a non-git directory, verify the icon does not appear

- [ ] **Step 6: Test command palette**

1. Open command palette (`Cmd+Shift+P`)
2. Type "git"
3. Verify "Git Changes" appears
4. Select it — modal should open

### Task 10: Fix any issues found during testing

- [ ] **Step 1: Fix any issues from manual testing**

Adjust component code as needed based on actual `@git-diff-view/react` API behavior, styling tweaks, or edge cases discovered during testing.

- [ ] **Step 2: Run existing tests to verify no regressions**

```bash
npm run test
```

Expected: All existing tests pass.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "fix: polish git changes modal after integration testing"
```
