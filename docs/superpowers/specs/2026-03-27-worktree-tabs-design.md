# Worktree Tabs Design

## Overview

Allow users to create git worktree tabs from any terminal tab that's in a git repo. Right-clicking a tab and selecting "Create Worktree" auto-creates a git worktree with an auto-named branch, spawns a new tab pointing at the worktree directory, and visually groups the original tab and all its worktree tabs under a collapsible group header. Fleet fully manages the worktree lifecycle — creation, persistence, and cleanup on close.

## UX Research (Baymard / NNG)

The visual grouping design is informed by Nielsen Norman Group and Baymard Institute research:

- **Common Region + Connectedness:** Grouped tabs share a left-edge accent bar (2px) acting as a visual container and connector. NNG: "Items within a boundary are perceived as a group."
- **Proximity:** Tighter vertical spacing within groups than between groups.
- **Progressive Disclosure:** Groups collapse to a single header row showing a count badge. Max two levels (parent + children). NNG: "Designs that go beyond 2 disclosure levels typically have low usability."
- **Context Menu Placement:** "Create Worktree" is a secondary action ideal for context menus. NNG: also expose it via command palette for discoverability.
- **Dual Selection Indicators:** Active tab within a group uses background highlight + bold text. NNG: "Use minimum two selection indicators simultaneously."
- **Confirmation on Destructive Actions:** Closing the parent tab triggers a confirmation dialog before closing all children and removing worktrees.

## Data Model

### Tab type extensions (`src/shared/types.ts`)

```ts
interface Tab {
  // ...existing fields...
  groupId?: string             // shared by all tabs in a worktree group
  groupRole?: 'parent' | 'worktree'  // parent = original tab, worktree = created variant
  worktreeBranch?: string      // auto-generated branch name for worktree tabs
  worktreePath?: string        // absolute path to worktree directory on disk
}
```

### Group collapse state

Stored in workspace store as `collapsedGroups: Set<string>` (set of groupIds). Serialized as an array for persistence. Not stored on individual tabs.

### Worktree directory convention

```
~/.fleet/worktrees/{repo-name}/{branch-name}/
```

Example: `~/.fleet/worktrees/fleet/fleet-worktree-1/`

### Group identity lifecycle

- **Creation:** First worktree from a tab generates a `groupId` (nanoid), assigns it to the original tab with `groupRole: 'parent'`, creates the new tab with same `groupId` and `groupRole: 'worktree'`.
- **Dissolution:** When the last worktree tab in a group is closed, `groupId`, `groupRole`, `worktreeBranch`, and `worktreePath` are cleared from the parent tab. Group header disappears.

## Worktree Service (`src/main/worktree-service.ts`)

Wraps `simple-git` worktree commands:

- **`create(repoPath: string)`** — runs `git worktree add <path> -b <branch>`. Path: `~/.fleet/worktrees/{repo-name}/{branch}-worktree-{n}`. Returns `{ worktreePath, branchName }`.
- **`remove(worktreePath: string)`** — runs `git worktree remove <path>`. Falls back to `--force` if dirty.
- **`list(repoPath: string)`** — runs `git worktree list --porcelain` for validation.

### IPC Channels

- `WORKTREE_CREATE` — renderer requests creation, main runs git + returns path/branch.
- `WORKTREE_REMOVE` — renderer requests cleanup on tab close.

### Tab close cleanup flow

1. User closes a worktree tab.
2. Workspace store calls `closeWorktreeTab(tabId)`.
3. PTY is killed (existing flow).
4. Renderer sends `WORKTREE_REMOVE` with `worktreePath`.
5. Main process runs `git worktree remove`.
6. If last worktree in group, parent tab's group fields are cleared.

### Parent tab close flow

1. User closes a parent tab that has worktree children.
2. Confirmation dialog: "This will close all worktree tabs in this group and remove their worktrees. Continue?"
3. On confirm: `closeWorktreeGroup(groupId)` — closes all tabs, removes all worktrees, kills all PTYs.

### Session restore

On startup, persisted workspace already has `worktreePath` on worktree tabs. Directories exist on disk. Fleet creates new PTYs pointing at those paths — no git commands needed.

## Sidebar UI & Visual Grouping

### Group header row

- Chevron icon (expand/collapse toggle).
- Repo name or base branch name as label.
- Count badge when collapsed (e.g., "3 tabs").
- Clicking header or chevron toggles collapse.

### Tabs within a group

- Indented 16px from ungrouped tabs.
- Connected by a thin 2px left-edge accent bar (subtle color, spans from first to last tab).
- Worktree tabs show branch name as subtitle beneath label.
- Parent tab has no special badge — just the first tab in the group.

### Collapsed state

Only the group header row is visible. All tabs (parent + worktrees) are hidden.

### Context menu changes (`TabItem.tsx`)

- **For tabs in a git repo (not already a worktree child):** Add "Create Worktree" menu item. If the tab is already a parent, creating another worktree adds another child to the same group.
- **For worktree child tabs:** "Create Worktree" is hidden (worktrees-of-worktrees are not allowed). "Close Tab" includes worktree cleanup. Add "Delete Worktree" as explicit destructive action.
- **For parent tabs with worktrees:** "Close Tab" shows confirmation, then closes entire group.

### Error handling

If `git worktree add` fails (not a git repo, branch conflict, disk error), show a toast notification with the error message. No tab or group is created. The original tab is unaffected.

## Drag & Drop

### Constraints

- **Tab within its group:** Can reorder among siblings with same `groupId` only. Cannot leave the group.
- **Group header drag:** Moves all tabs in the group as a contiguous block. Drop targets are between other top-level items (ungrouped tabs or other group headers).
- **Ungrouped tab drag:** Can drop between other ungrouped tabs or between groups. Cannot drop inside a group.
- **Visual feedback:** Blue drop indicator line only appears at valid positions. Drop zones between grouped tabs are suppressed for external drags.

## Workspace Store Actions (`workspace-store.ts`)

- **`createWorktreeGroup(tabId, worktreePath, branchName)`** — assigns `groupId` to source tab (parent), creates new worktree tab with same `groupId`.
- **`closeWorktreeTab(tabId)`** — closes tab, triggers IPC cleanup. If last worktree in group, clears parent's group fields.
- **`closeWorktreeGroup(groupId)`** — closes all tabs in group after confirmation, triggers cleanup for each worktree.
- **`toggleGroupCollapsed(groupId)`** — toggles group in/out of `collapsedGroups`.
- **`reorderWithinGroup(groupId, fromIndex, toIndex)`** — reorders tabs within group only.
- **`reorderGroup(groupId, targetIndex)`** — moves entire group block to new position among top-level items.

## Persistence

- All group-related fields (`groupId`, `groupRole`, `worktreeBranch`, `worktreePath`) are on the `Tab` type and saved automatically via existing workspace persistence.
- `collapsedGroups` is serialized as an array of groupIds and saved with the workspace in `layout-store.ts`.
- No schema migration needed — old workspaces have no tabs with `groupId`, which works seamlessly.

## Files to Create/Modify

### New files
- `src/main/worktree-service.ts` — git worktree operations

### Modified files
- `src/shared/types.ts` — Tab type extensions
- `src/shared/ipc-channels.ts` — new WORKTREE_CREATE, WORKTREE_REMOVE channels
- `src/shared/ipc-api.ts` — payload types for worktree IPC
- `src/preload/index.ts` — expose worktree IPC to renderer
- `src/main/ipc-handlers.ts` — register worktree IPC handlers
- `src/renderer/src/store/workspace-store.ts` — new group actions, collapsedGroups state
- `src/renderer/src/components/Sidebar.tsx` — group header rendering, group-aware drag & drop
- `src/renderer/src/components/TabItem.tsx` — indentation, accent bar, context menu additions
- `src/main/layout-store.ts` — serialize/deserialize collapsedGroups
