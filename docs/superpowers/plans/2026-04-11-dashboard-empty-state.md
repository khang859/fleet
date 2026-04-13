# Dashboard Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal "No tabs open" empty state with a styled dashboard showing ASCII art, a New Terminal action, and recent files/folders.

**Architecture:** A new `Dashboard.tsx` component replaces the empty-state `div` in `App.tsx`. Recent folders tracking is added to the existing workspace store alongside the recent files pattern. The dashboard renders only when no tabs are open.

**Tech Stack:** React, Zustand, Tailwind CSS, lucide-react

---

### File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/renderer/src/store/workspace-store.ts` | Modify | Add `recentFolders` state, load/save helpers, `addRecentFolder()` action |
| `src/renderer/src/components/Dashboard.tsx` | Create | Dashboard UI component with ASCII art, action, recent lists |
| `src/renderer/src/App.tsx` | Modify | Import `Dashboard`, wire it into the empty-state slot |

---

### Task 1: Add recent folders tracking to workspace store

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add constants and load/save helpers**

Add below the existing `saveRecentFiles` function (after line 31):

```ts
const RECENT_FOLDERS_KEY = 'fleet:recent-folders';
const MAX_RECENT_FOLDERS = 10;

function loadRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function saveRecentFolders(folders: string[]): void {
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders));
  } catch {
    // ignore storage errors
  }
}
```

- [ ] **Step 2: Add `recentFolders` to the store type**

In the `WorkspaceStore` type (around line 112), add after `recentFiles: string[];`:

```ts
recentFolders: string[];
```

And in the actions section (around line 160), add after `addRecentFile: (filePath: string) => void;`:

```ts
addRecentFolder: (folderPath: string) => void;
```

- [ ] **Step 3: Initialize state and implement action**

In the `create<WorkspaceStore>` call, add after `recentFiles: loadRecentFiles(),` (line 255):

```ts
recentFolders: loadRecentFolders(),
```

Add the `addRecentFolder` action after the `addRecentFile` action (after line 929):

```ts
addRecentFolder: (folderPath) => {
  set((state) => {
    const filtered = state.recentFolders.filter((f) => f !== folderPath);
    const updated = [folderPath, ...filtered].slice(0, MAX_RECENT_FOLDERS);
    saveRecentFolders(updated);
    return { recentFolders: updated };
  });
},
```

- [ ] **Step 4: Call `addRecentFolder` when workspaces are loaded**

In the `loadWorkspace` method (line 702), add at the end of the function body, just before the closing `}` of the `set()` call — or after it as a separate call. Add after the `set({...})` block (after line 735):

```ts
const folderCwd = workspace.tabs[0]?.cwd;
if (folderCwd) {
  get().addRecentFolder(folderCwd);
}
```

Do the same in `switchWorkspace` (line 746) — add after the main `set()` block at the end of the function:

```ts
const folderCwd = ws.tabs[0]?.cwd;
if (folderCwd) {
  get().addRecentFolder(folderCwd);
}
```

- [ ] **Step 5: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat: add recent folders tracking to workspace store"
```

---

### Task 2: Create Dashboard component

**Files:**
- Create: `src/renderer/src/components/Dashboard.tsx`

- [ ] **Step 1: Create the Dashboard component file**

Create `src/renderer/src/components/Dashboard.tsx`:

```tsx
import { Terminal, Folder, FileText } from 'lucide-react';

const ASCII_LINES = [
  '███████╗██╗     ███████╗███████╗████████╗',
  '██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝',
  '█████╗  ██║     █████╗  █████╗     ██║   ',
  '██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   ',
  '██║     ███████╗███████╗███████╗   ██║   ',
  '╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   ',
];

const LINE_COLORS = [
  'text-teal-500',
  'text-teal-500',
  'text-cyan-500',
  'text-cyan-500',
  'text-cyan-400',
  'text-cyan-400',
];

function shortenPath(fullPath: string): string {
  const home = window.fleet?.env?.HOME ?? '';
  if (home && fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}

type DashboardProps = {
  recentFiles: string[];
  recentFolders: string[];
  onNewTerminal: () => void;
  onOpenFile: (filePath: string) => void;
  onOpenFolder: (folderPath: string) => void;
};

export function Dashboard({
  recentFiles,
  recentFolders,
  onNewTerminal,
  onOpenFile,
  onOpenFolder,
}: DashboardProps): React.JSX.Element {
  const displayFiles = recentFiles.slice(0, 10);
  const displayFolders = recentFolders.slice(0, 10);

  return (
    <div className="flex items-center justify-center h-full select-none">
      <div className="flex flex-col items-center gap-8 max-w-xl">
        {/* ASCII Art Header */}
        <pre className="text-sm leading-tight font-mono">
          {ASCII_LINES.map((line, i) => (
            <span key={i} className={`block ${LINE_COLORS[i]}`}>
              {line}
            </span>
          ))}
        </pre>

        {/* Tagline */}
        <p className="text-neutral-600 text-xs tracking-wide">
          terminal multiplexer for ai agents
        </p>

        {/* New Terminal Action */}
        <button
          onClick={onNewTerminal}
          className="flex items-center gap-3 text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer group"
        >
          <Terminal size={16} />
          <span className="text-sm">New Terminal</span>
          <kbd className="text-xs text-neutral-600 group-hover:text-neutral-500 ml-2">⌘T</kbd>
        </button>

        {/* Recent Folders */}
        {displayFolders.length > 0 && (
          <div className="w-full">
            <h3 className="text-neutral-600 text-xs uppercase tracking-wider mb-2 flex items-center gap-2">
              <Folder size={12} />
              Recent Folders
            </h3>
            <ul className="space-y-1">
              {displayFolders.map((folder) => (
                <li key={folder}>
                  <button
                    onClick={() => onOpenFolder(folder)}
                    className="text-sm text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer truncate block w-full text-left"
                  >
                    {shortenPath(folder)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recent Files */}
        {displayFiles.length > 0 && (
          <div className="w-full">
            <h3 className="text-neutral-600 text-xs uppercase tracking-wider mb-2 flex items-center gap-2">
              <FileText size={12} />
              Recent Files
            </h3>
            <ul className="space-y-1">
              {displayFiles.map((file) => (
                <li key={file}>
                  <button
                    onClick={() => onOpenFile(file)}
                    className="text-sm text-neutral-400 hover:text-cyan-400 transition-colors cursor-pointer truncate block w-full text-left"
                  >
                    {shortenPath(file)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Check how HOME env is exposed to renderer**

The `shortenPath` function uses `window.fleet.env.HOME`. Verify this exists. If it doesn't, we need to check how preload exposes env vars and adjust accordingly. Look at `src/preload/index.ts` for the `fleet` API surface.

If `window.fleet.env.HOME` doesn't exist, fall back to a hardcoded approach:

```ts
function shortenPath(fullPath: string): string {
  // Electron exposes OS homedir; fall back to common prefixes
  const home = '/Users/' + fullPath.split('/')[2]; // macOS heuristic
  if (fullPath.startsWith(home + '/')) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}
```

Or expose `os.homedir()` via preload if cleaner.

- [ ] **Step 3: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/Dashboard.tsx
git commit -m "feat: add Dashboard empty state component"
```

---

### Task 3: Integrate Dashboard into App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add Dashboard import**

At the top of `App.tsx`, add with the other component imports (around line 8):

```ts
import { Dashboard } from './components/Dashboard';
```

- [ ] **Step 2: Pull recentFiles and recentFolders from the store**

In the `useWorkspaceStore(useShallow(...))` call (lines 83-105), add `recentFiles`, `recentFolders`, and `openFile` to the destructured selections:

```ts
const {
  workspace,
  backgroundWorkspaces,
  activeTabId,
  activePaneId,
  setActiveTab,
  setActivePane,
  addTab,
  lastClosedTab,
  undoCloseTab,
  recentFiles,
  recentFolders,
  openFile,
} = useWorkspaceStore(
  useShallow((s) => ({
    workspace: s.workspace,
    backgroundWorkspaces: s.backgroundWorkspaces,
    activeTabId: s.activeTabId,
    activePaneId: s.activePaneId,
    setActiveTab: s.setActiveTab,
    setActivePane: s.setActivePane,
    addTab: s.addTab,
    lastClosedTab: s.lastClosedTab,
    undoCloseTab: s.undoCloseTab,
    recentFiles: s.recentFiles,
    recentFolders: s.recentFolders,
    openFile: s.openFile,
  }))
);
```

- [ ] **Step 3: Replace the empty-state div with Dashboard**

Replace the empty-state block at lines 762-765:

```tsx
// Before:
<div className="flex items-center justify-center h-full text-neutral-600">
  No tabs open. Press Cmd+T to create one.
</div>

// After:
<Dashboard
  recentFiles={recentFiles}
  recentFolders={recentFolders}
  onNewTerminal={() => addTab(undefined, workspace.tabs[0]?.cwd ?? '/')}
  onOpenFile={(filePath) => openFile(filePath)}
  onOpenFolder={(folderPath) => addTab(undefined, folderPath)}
/>
```

- [ ] **Step 4: Verify typecheck passes**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 5: Verify lint passes**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 6: Test manually**

Run: `npm run dev`

Verify:
1. Launch the app — dashboard should appear with ASCII art, tagline, and New Terminal button
2. Click "New Terminal" — should create a terminal tab and dashboard disappears
3. Close all tabs — dashboard should reappear
4. Recent files section should show if you've opened files before
5. Recent folders section will be empty on first run (populates as workspaces are loaded)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: integrate Dashboard into empty state slot"
```
