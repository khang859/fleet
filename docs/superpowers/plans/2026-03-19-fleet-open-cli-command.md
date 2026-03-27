# `fleet open` CLI Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `fleet open <path> [path2 ...]` CLI command that opens files and images in new tabs in the running Fleet app, with dedup (focus existing tab if already open).

**Architecture:** CLI validates paths and determines pane types, sends a `file.open` socket command. Socket server emits a `file-open` event. `index.ts` catches it and forwards via `webContents.send()` to the renderer. Renderer creates/focuses tabs using the workspace store.

**Tech Stack:** TypeScript, Electron IPC, node `fs`/`path`, Zustand (workspace store)

---

### Task 1: Add IPC constant

**Files:**

- Modify: `src/shared/constants.ts:68` (add before `SYSTEM_CHECK` line)

- [ ] **Step 1: Add the IPC channel constant**

In `src/shared/constants.ts`, add `FILE_OPEN_IN_TAB` to `IPC_CHANNELS` right after `FILE_READ_BINARY`:

```typescript
FILE_READ_BINARY: 'file:read-binary',
FILE_OPEN_IN_TAB: 'file:open-in-tab',
SYSTEM_CHECK: 'system:check',
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to constants

- [ ] **Step 3: Commit**

```bash
git add src/shared/constants.ts
git commit -m "feat(cli): add FILE_OPEN_IN_TAB IPC channel constant"
```

---

### Task 2: Add preload listener

**Files:**

- Modify: `src/preload/index.ts:194` (add after `readBinary` in the `file` namespace)

- [ ] **Step 1: Add `onOpenInTab` to the file namespace in preload**

In `src/preload/index.ts`, add after the `readBinary` method (line 193) inside the `file` object:

```typescript
    readBinary: (filePath: string): Promise<{ success: boolean; data?: { base64: string; mimeType: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_BINARY, filePath),
    onOpenInTab: (callback: (payload: { files: Array<{ path: string; paneType: 'file' | 'image'; label: string }> }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { files: Array<{ path: string; paneType: 'file' | 'image'; label: string }> }) =>
        callback(payload)
      ipcRenderer.on(IPC_CHANNELS.FILE_OPEN_IN_TAB, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.FILE_OPEN_IN_TAB, handler)
    },
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(cli): add onOpenInTab preload listener"
```

---

### Task 3: Add `openFileInTab` method to workspace store (with dedup)

**Files:**

- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add `openFileInTab` to the store interface and implementation**

Find the `openFile` method in the workspace store. After it, add a new method `openFileInTab` that has dedup logic. This is separate from `openFile` (which always creates a new tab, used by Cmd+O).

The method should:

1. Accept an array of `{ path: string; paneType: 'file' | 'image'; label: string }`
2. For each file, search existing tabs for a pane with matching `filePath`
3. If found, set that tab as active
4. If not found, create a new `Tab` with a single `PaneLeaf` and add it

Add to the store's type interface (near `openFile`):

```typescript
openFileInTab: (files: Array<{ path: string; paneType: 'file' | 'image'; label: string }>) => void;
```

Add the implementation after `openFile`:

```typescript
openFileInTab: (files) => {
  for (const file of files) {
    const state = get();
    // Dedup: check if file is already open in any tab
    const existingTab = state.workspace.tabs.find((tab) => {
      const leaf = tab.splitRoot;
      if (leaf.type === 'leaf' && leaf.filePath === file.path) return true;
      // For split panes, walk the tree
      const findLeaf = (node: PaneNode): boolean => {
        if (node.type === 'leaf') return node.filePath === file.path;
        return findLeaf(node.children[0]) || findLeaf(node.children[1]);
      };
      return findLeaf(tab.splitRoot);
    });

    if (existingTab) {
      // Focus existing tab
      set({ activeTabId: existingTab.id, isDirty: true });
    } else {
      // Create new tab
      const leaf: PaneLeaf = {
        type: 'leaf',
        id: generateId(),
        cwd: '/',
        paneType: file.paneType,
        filePath: file.path,
      };
      const tab: Tab = {
        id: generateId(),
        label: file.label,
        labelIsCustom: true,
        cwd: '/',
        type: file.paneType === 'image' ? 'image' : 'file',
        splitRoot: leaf,
      };
      set((s) => ({
        workspace: { ...s.workspace, tabs: [...s.workspace.tabs, tab] },
        activeTabId: tab.id,
        activePaneId: leaf.id,
        isDirty: true,
      }));
    }
  }
},
```

Note: Import `PaneNode` if not already imported — check the existing imports at the top of the file.

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(cli): add openFileInTab with dedup to workspace store"
```

---

### Task 4: Wire up IPC listener in App.tsx

**Files:**

- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add useEffect for `file:open-in-tab` IPC**

In `App.tsx`, add a `useEffect` near the other IPC listeners (around line 140-154). Follow the same pattern as `onCreateTab`:

```typescript
useEffect(() => {
  const cleanup = window.fleet.file.onOpenInTab((payload) => {
    useWorkspaceStore.getState().openFileInTab(payload.files);
  });
  return () => {
    cleanup();
  };
}, []);
```

- [ ] **Step 2: Verify no TypeScript errors**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(cli): wire up file:open-in-tab IPC listener in renderer"
```

---

### Task 5: Add `file.open` command to socket server dispatch

**Files:**

- Modify: `src/main/socket-server.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add `file.open` case to `dispatch()` in socket-server.ts**

In `src/main/socket-server.ts`, add a new case in the `dispatch()` switch before the `default` case (line 402):

```typescript
      // ── File Open ──────────────────────────────────────────────────────────────
      case 'file.open': {
        const files = args.files as Array<{ path: string; paneType: 'file' | 'image' }>;
        if (!files || !Array.isArray(files) || files.length === 0) {
          const err = new Error('file.open requires a non-empty files array') as Error & { code: string };
          err.code = 'BAD_REQUEST';
          throw err;
        }
        const payload = {
          files: files.map((f) => ({
            path: f.path,
            paneType: f.paneType,
            label: f.path.split('/').pop() ?? f.path,
          })),
        };
        this.emit('file-open', payload);
        return { fileCount: files.length };
      }
```

- [ ] **Step 2: Wire the `file-open` event in `index.ts`**

In `src/main/index.ts`, after the existing `socketServer.on('state-change', ...)` listener (around line 229), add:

```typescript
socketServer.on('file-open', (payload: unknown) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.FILE_OPEN_IN_TAB, payload);
  }
});
```

Make sure `IPC_CHANNELS` is already imported (it should be — verify at top of file).

- [ ] **Step 3: Verify no TypeScript errors**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/socket-server.ts src/main/index.ts
git commit -m "feat(cli): add file.open socket command with IPC forwarding"
```

---

### Task 6: Add `fleet open` to CLI parser

**Files:**

- Modify: `src/main/fleet-cli.ts`

- [ ] **Step 1: Add file system imports**

At the top of `src/main/fleet-cli.ts`, add `existsSync` and `statSync` from `node:fs`:

```typescript
import { existsSync, statSync } from 'node:fs';
```

And extend the existing `import { join } from 'node:path'` (line 3) to include `resolve`, `extname`, and `basename`:

```typescript
import { join, resolve, extname, basename } from 'node:path';
```

- [ ] **Step 2: Add constants for file type detection**

After the imports (before the `CLIResponse` interface), add:

```typescript
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico'
]);

const BINARY_BLOCKLIST = new Set([
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.exe',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
  '.iso',
  '.bin',
  '.dll',
  '.so',
  '.dylib',
  '.o',
  '.a',
  '.wasm',
  '.class',
  '.jar',
  '.war',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.flac',
  '.wav',
  '.aac'
]);
```

- [ ] **Step 3: Add the `open` command handler in `runCLI()`**

In `runCLI()`, right after `const [group, action, ...rest] = argv;` (line 224) and before the `if (!group || !action)` check (line 226), add the `open` handler:

```typescript
// ── Top-level "open" command ─────────────────────────────────────────────
if (group === 'open') {
  const paths = [action, ...rest].filter(Boolean);
  if (paths.length === 0) {
    return 'Usage: fleet open <path> [path2 ...]';
  }

  const errors: string[] = [];
  const files: Array<{ path: string; paneType: 'file' | 'image' }> = [];

  for (const p of paths) {
    const resolved = resolve(p);

    if (!existsSync(resolved)) {
      errors.push(`Error: file not found: ${p}`);
      continue;
    }

    if (statSync(resolved).isDirectory()) {
      errors.push(`Error: directories not supported, use a file path: ${p}`);
      continue;
    }

    const ext = extname(resolved).toLowerCase();
    if (BINARY_BLOCKLIST.has(ext)) {
      errors.push(`Error: unsupported binary file: ${p}`);
      continue;
    }

    const paneType = IMAGE_EXTENSIONS.has(ext) ? ('image' as const) : ('file' as const);
    files.push({ path: resolved, paneType });
  }

  if (files.length === 0) {
    return errors.join('\n');
  }

  const cli = new FleetCLI(sockPath);
  try {
    const response = await cli.send('file.open', { files });
    if (!response.ok) {
      return `Error: ${response.error ?? 'Unknown error'}`;
    }
    const output =
      errors.length > 0
        ? errors.join('\n') + '\n' + `Opened ${files.length} file(s) in Fleet`
        : `Opened ${files.length} file(s) in Fleet`;
    return output;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOENT')) {
      return 'Fleet is not running';
    }
    return `Error: ${msg}`;
  }
}
```

- [ ] **Step 4: Verify no TypeScript errors**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/fleet-cli.ts
git commit -m "feat(cli): add fleet open command with path validation"
```

---

### Task 7: Add `fleet open` to skill documentation

**Files:**

- Modify: `src/main/starbase/workspace-templates.ts`

- [ ] **Step 1: Add `fleet open` to the Full Command Reference**

In `src/main/starbase/workspace-templates.ts`, find the "Full Command Reference" section in `generateSkillMd()`. Add a new section for `fleet open` before the existing command groups. Look for the line that starts the command reference (around line 150) and add:

```typescript
## File Operations

\`\`\`bash
fleet open <path> [path2 ...]    # Open file(s) or image(s) in Fleet tabs
\`\`\`

```

- [ ] **Step 2: Commit**

```bash
git add src/main/starbase/workspace-templates.ts
git commit -m "docs: add fleet open to skill documentation"
```

---

### Task 8: Manual integration test

- [ ] **Step 1: Build the project**

Run: `npm run build` (or whatever the build command is — check `package.json`)
Expected: Build succeeds

- [ ] **Step 2: Test `fleet open` with a text file**

1. Start the Fleet app
2. Run: `fleet open README.md`
3. Verify: A new tab appears with the file content in the editor

- [ ] **Step 3: Test with an image**

Run: `fleet open some-image.png`
Verify: A new tab appears with the image viewer

- [ ] **Step 4: Test dedup**

Run: `fleet open README.md` again
Verify: The existing tab is focused, no duplicate tab created

- [ ] **Step 5: Test multiple files**

Run: `fleet open README.md package.json`
Verify: Two tabs created, `package.json` tab is active (last one)

- [ ] **Step 6: Test error cases**

```bash
fleet open nonexistent.md          # → "Error: file not found: nonexistent.md"
fleet open src/                    # → "Error: directories not supported..."
fleet open archive.zip             # → "Error: unsupported binary file: archive.zip"
```

- [ ] **Step 7: Final commit if any fixes were needed**
