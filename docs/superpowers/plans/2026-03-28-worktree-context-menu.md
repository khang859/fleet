# Always-Visible "Create Worktree" Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Create Worktree" context menu item always visible on terminal tabs, disabled with an explanation when unavailable, instead of conditionally hiding it.

**Architecture:** Replace the binary show/hide logic with a `worktreeDisabledReason` prop. Sidebar computes the reason string (or `null` for enabled), TabItem renders accordingly with a GitBranch icon and disabled subtitle.

**Tech Stack:** React, Radix UI Context Menu, lucide-react (already installed), Tailwind CSS

---

### Task 1: Update TabItem props and context menu rendering

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx`

- [ ] **Step 1: Update the import to include GitBranch icon**

Add `GitBranch` to the imports at the top of the file:

```typescript
import { GitBranch } from 'lucide-react';
```

- [ ] **Step 2: Replace `isWorktreeChild` prop with `worktreeDisabledReason`**

In the `TabItemProps` type, replace these two lines:

```typescript
  /** Called when user selects "Create Worktree" from context menu */
  onCreateWorktree?: () => void;
  /** True if this tab is a worktree child (hides "Create Worktree" option) */
  isWorktreeChild?: boolean;
```

with:

```typescript
  /** Called when user selects "Create Worktree" from context menu */
  onCreateWorktree?: () => void;
  /** null = enabled, string = disabled with this reason shown as subtitle. undefined = don't show item at all (non-terminal tabs). */
  worktreeDisabledReason?: string | null;
```

- [ ] **Step 3: Update the destructured props in the component function**

Replace `isWorktreeChild` in the destructuring:

```typescript
  onCreateWorktree,
  worktreeDisabledReason,
  worktreeBranch,
```

(Remove `isWorktreeChild` from the destructuring.)

- [ ] **Step 4: Replace the conditional worktree context menu block**

Replace this block (lines 304–314):

```tsx
          {onCreateWorktree && !isWorktreeChild && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-neutral-700" />
              <ContextMenu.Item
                className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-neutral-700 hover:bg-neutral-700"
                onSelect={onCreateWorktree}
              >
                Create Worktree
              </ContextMenu.Item>
            </>
          )}
```

with:

```tsx
          {worktreeDisabledReason !== undefined && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-neutral-700" />
              <ContextMenu.Item
                className={`px-2 py-1.5 rounded outline-none ${
                  worktreeDisabledReason === null
                    ? 'cursor-pointer focus:bg-neutral-700 hover:bg-neutral-700'
                    : 'cursor-default text-neutral-500'
                }`}
                disabled={worktreeDisabledReason !== null}
                onSelect={() => {
                  if (worktreeDisabledReason === null) onCreateWorktree?.();
                }}
              >
                <div className="flex items-center gap-2">
                  <GitBranch size={14} />
                  <span>Create Worktree</span>
                </div>
                {worktreeDisabledReason && (
                  <div className="text-xs text-neutral-500 mt-0.5 ml-6">
                    {worktreeDisabledReason}
                  </div>
                )}
              </ContextMenu.Item>
            </>
          )}
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: Type errors in Sidebar.tsx because it still passes the old `isWorktreeChild` prop. TabItem.tsx itself should be clean.

- [ ] **Step 6: Commit TabItem changes**

```bash
git add src/renderer/src/components/TabItem.tsx
git commit -m "refactor(ui): make Create Worktree menu item always-visible with disabled state"
```

---

### Task 2: Update Sidebar to compute and pass `worktreeDisabledReason`

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Replace `isWorktreeChild` and `onCreateWorktree` props**

Find the TabItem usage in Sidebar.tsx (around line 1278–1289). Replace these lines:

```tsx
                  isWorktreeChild={tab.groupRole === 'worktree'}
                  onCreateWorktree={
                    !isFile && gitRepoTabs.has(tab.id) && !tab.worktreePath && !tab.groupId
                      ? () => {
                          const firstPane = collectPaneIds(tab.splitRoot)[0];
                          const liveCwd = firstPane ? liveCwds.get(firstPane) : undefined;
                          void handleCreateWorktree(tab.id, liveCwd ?? tab.cwd);
                        }
                      : undefined
                  }
```

with:

```tsx
                  worktreeDisabledReason={
                    isFile ? undefined
                      : tab.groupRole === 'worktree' ? 'Already a worktree'
                      : tab.groupId ? 'Worktrees already created'
                      : !gitRepoTabs.has(tab.id) ? 'Not a git repository'
                      : null
                  }
                  onCreateWorktree={
                    !isFile && gitRepoTabs.has(tab.id) && !tab.worktreePath && !tab.groupId
                      ? () => {
                          const firstPane = collectPaneIds(tab.splitRoot)[0];
                          const liveCwd = firstPane ? liveCwds.get(firstPane) : undefined;
                          void handleCreateWorktree(tab.id, liveCwd ?? tab.cwd);
                        }
                      : undefined
                  }
```

Note: `onCreateWorktree` is kept with the same logic — it's only defined when the action is actually available. The `worktreeDisabledReason` controls visibility/disabled state independently.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Commit Sidebar changes**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(ui): show Create Worktree on all terminal tabs with disabled reason"
```

---

### Task 3: Manual verification

- [ ] **Step 1: Build the app**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: Verify visually (manual)**

Launch the app and verify these scenarios:
1. Right-click a terminal tab in a git repo → "Create Worktree" enabled with GitBranch icon
2. Right-click a terminal tab in a non-git folder → "Create Worktree" disabled, subtitle "Not a git repository"
3. Right-click a worktree child tab → "Create Worktree" disabled, subtitle "Already a worktree"
4. Right-click a parent tab that has worktrees → "Create Worktree" disabled, subtitle "Worktrees already created"
5. Right-click a file/settings tab → No "Create Worktree" item shown
