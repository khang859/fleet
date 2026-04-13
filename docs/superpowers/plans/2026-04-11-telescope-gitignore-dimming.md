# Telescope Browse Mode: Gitignore-Aware File Dimming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dim gitignored files/folders in telescope Browse mode using muted text color (`text-neutral-600`) so users can visually distinguish project files from build artifacts/dependencies.

**Architecture:** Add a `FILE_CHECK_IGNORED` IPC channel that runs `git check-ignore` on a directory's entries. Browse mode calls this after `readdir()`, attaches `isIgnored` to each item's `data`. TelescopeModal applies the muted color class for ignored items.

**Tech Stack:** Electron IPC, `git check-ignore`, React, Tailwind CSS

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/ipc-channels.ts` | Modify (line 34) | Add `FILE_CHECK_IGNORED` channel constant |
| `src/main/ipc-handlers.ts` | Modify (after line 401) | Add IPC handler that runs `git check-ignore` |
| `src/preload/index.ts` | Modify (line 191) | Expose `file.checkIgnored()` to renderer |
| `src/renderer/src/components/Telescope/modes/browse-mode.ts` | Modify | Call `checkIgnored` after `readdir`, attach `isIgnored` flag |
| `src/renderer/src/components/Telescope/TelescopeModal.tsx` | Modify (line 441) | Apply muted color for ignored items |

---

### Task 1: Add IPC Channel Constant

**Files:**
- Modify: `src/shared/ipc-channels.ts:34`

- [ ] **Step 1: Add the channel constant**

In `src/shared/ipc-channels.ts`, add `FILE_CHECK_IGNORED` after `FILE_RECENT_IMAGES` (line 34):

```typescript
  FILE_RECENT_IMAGES: 'file:recent-images',
  FILE_CHECK_IGNORED: 'file:check-ignored',
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (new constant is just added, not used yet)

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts
git commit -m "feat(telescope): add FILE_CHECK_IGNORED IPC channel constant"
```

---

### Task 2: Add IPC Handler in Main Process

**Files:**
- Modify: `src/main/ipc-handlers.ts` (after line 401, after `FILE_READDIR` handler)

- [ ] **Step 1: Add the handler**

In `src/main/ipc-handlers.ts`, add this handler after the `FILE_READDIR` handler (after line 401):

```typescript
  // Check which entries in a directory are gitignored (returns ignored names)
  ipcMain.handle(
    IPC_CHANNELS.FILE_CHECK_IGNORED,
    async (_event, { dirPath }: { dirPath: string }): Promise<string[]> => {
      try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const names = entries
          .filter((e) => e.isFile() || e.isDirectory())
          .map((e) => e.name);
        if (names.length === 0) return [];

        const { stdout } = await execAsync(
          `git check-ignore ${names.map((n) => `'${n.replace(/'/g, "'\\''")}'`).join(' ')}`,
          { cwd: dirPath, maxBuffer: 1024 * 1024 }
        );
        return stdout.split('\n').filter(Boolean);
      } catch {
        // git check-ignore exits with code 1 when no files are ignored,
        // or fails if not a git repo — both cases mean "nothing ignored"
        return [];
      }
    }
  );
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(telescope): add FILE_CHECK_IGNORED IPC handler"
```

---

### Task 3: Expose `checkIgnored` in Preload

**Files:**
- Modify: `src/preload/index.ts` (inside `file` object, after `searchRecentImages` around line 210)

- [ ] **Step 1: Add the preload method**

In `src/preload/index.ts`, add `checkIgnored` to the `file` object, after the `searchRecentImages` method (line 210):

```typescript
    searchRecentImages: async (): Promise<RecentImagesResponse> =>
      typedInvoke(IPC_CHANNELS.FILE_RECENT_IMAGES),
    checkIgnored: async (dirPath: string): Promise<string[]> =>
      typedInvoke(IPC_CHANNELS.FILE_CHECK_IGNORED, { dirPath }),
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(telescope): expose file.checkIgnored in preload API"
```

---

### Task 4: Integrate `checkIgnored` into Browse Mode

**Files:**
- Modify: `src/renderer/src/components/Telescope/modes/browse-mode.ts`

- [ ] **Step 1: Add ignore cache and fetch logic to `loadDir`**

In `browse-mode.ts`, add a module-level cache and update `loadDir` to fetch ignored entries. Replace the existing `loadDir` function and add the cache before `createBrowseMode`:

Add the cache before the function:

```typescript
// Module-level cache for gitignore results per directory
const ignoreCache = new Map<string, Set<string>>();
```

Replace the `loadDir` function body inside `createBrowseMode` (lines 28-48) with:

```typescript
  async function loadDir(dir: string): Promise<void> {
    state.currentDir = dir;
    state.loading = true;
    onStateChange();

    const result = await window.fleet.file.readdir(dir);
    if (result.success) {
      // Sort: directories first, then alphabetical within each group
      state.entries = [...result.entries].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

      // Fetch gitignore status (use cache if available)
      if (!ignoreCache.has(dir)) {
        const ignored = await window.fleet.file.checkIgnored(dir);
        ignoreCache.set(dir, new Set(ignored));
      }
      state.ignoredNames = ignoreCache.get(dir) ?? new Set();
    } else {
      state.entries = [];
      state.ignoredNames = new Set();
    }

    state.loading = false;
    onStateChange();
  }
```

- [ ] **Step 2: Add `ignoredNames` to `BrowseState`**

Update the `BrowseState` type at the top of the file:

```typescript
type BrowseState = {
  currentDir: string;
  entries: DirEntry[];
  loading: boolean;
  ignoredNames: Set<string>;
};
```

And update the initial state inside `createBrowseMode`:

```typescript
  const state: BrowseState = {
    currentDir: cwd,
    entries: [],
    loading: false,
    ignoredNames: new Set()
  };
```

- [ ] **Step 3: Attach `isIgnored` flag to each TelescopeItem**

Update the `onSearch` method's `entries.map` call (around line 84-94) to include `isIgnored` in the `data`:

```typescript
      return entries.map(
        (entry): TelescopeItem => ({
          id: entry.path,
          icon: entry.isDirectory
            ? createElement(Folder, { size: 14, className: 'text-blue-400' })
            : getFileIcon(entry.name),
          title: entry.name,
          subtitle: entry.isDirectory ? 'Directory' : undefined,
          data: {
            filePath: entry.path,
            isDirectory: entry.isDirectory,
            isIgnored: state.ignoredNames.has(entry.name) || entry.name === '.git'
          }
        })
      );
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Telescope/modes/browse-mode.ts
git commit -m "feat(telescope): fetch gitignore status in browse mode"
```

---

### Task 5: Apply Muted Color in TelescopeModal

**Files:**
- Modify: `src/renderer/src/components/Telescope/TelescopeModal.tsx` (line 441)

- [ ] **Step 1: Update the result item className**

In `TelescopeModal.tsx`, update the `<button>` className for result items (around line 441-444). Replace:

```typescript
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                      isSelected
                        ? 'bg-neutral-700 text-white'
                        : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
```

With:

```typescript
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors ${
                      isSelected
                        ? 'bg-neutral-700 text-white'
                        : item.data?.isIgnored
                          ? 'text-neutral-600 hover:bg-neutral-800'
                          : 'text-neutral-300 hover:bg-neutral-800'
                    }`}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Telescope/TelescopeModal.tsx
git commit -m "feat(telescope): dim gitignored files in browse mode"
```

---

### Task 6: Manual Verification

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Test Browse mode in a git repo**

1. Open telescope (Cmd+Shift+T)
2. Switch to Browse mode (Cmd+3)
3. Navigate to a directory with gitignored files (e.g., project root should show `node_modules/`, `dist/`, `.git/`)
4. Verify: ignored files/folders appear in muted gray (`text-neutral-600`), tracked files appear normal (`text-neutral-300`)
5. Verify: selecting an ignored file still highlights it white — selection always wins
6. Verify: clicking/entering an ignored directory still works (navigation not blocked)

- [ ] **Step 3: Test in a non-git directory**

1. In Browse mode, navigate to a directory outside any git repo (e.g., `~/`)
2. Verify: all files render in normal color, no dimming, no errors

- [ ] **Step 4: Test cache behavior**

1. Navigate into a directory, then back out, then back in
2. Verify: no visible delay on second visit (cache hit)
