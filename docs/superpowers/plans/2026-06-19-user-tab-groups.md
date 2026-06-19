# User-Created Tab Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-created, collapsible tab groups to the sidebar with custom names and 8-color identifiers.

**Architecture:** New `UserGroup` type stored on `Workspace.userGroups[]`, referenced by `Tab.userGroupId`. Store actions in `workspace-store.ts`. Rendering in `Sidebar.tsx` nests user groups around existing worktree group rendering. New `ColorPalettePicker` component for color selection.

**Tech Stack:** Electron + React + TypeScript + Zustand + Radix UI ContextMenu + Tailwind CSS

---

### Task 1: Add `UserGroup` type and update `Workspace`/`Tab`

**Files:**
- Create: `src/shared/group-colors.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/renderer/src/components/sidebar-constants.ts`

- [ ] **Step 1: Create shared color palette module**

Create file `src/shared/group-colors.ts`:

```ts
export const USER_GROUP_COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'] as const;

export type UserGroupColor = typeof USER_GROUP_COLORS[number];
```

- [ ] **Step 2: Add `UserGroup` type and update `Workspace`/`Tab` in `types.ts`**

Add import at top of `src/shared/types.ts`:

```ts
import type { UserGroupColor } from './group-colors';
```

Add `UserGroup` type (after `Workspace` type, before `Tab`):

```ts
export type UserGroup = {
  id: string;
  name: string;
  color: UserGroupColor;
  collapsed: boolean;
};
```

Add `userGroups` to `Workspace` right after `sidebarWidth?: number`:

```ts
userGroups?: UserGroup[];
```

Add `userGroupId` to `Tab` right after `worktreePath?: string`:

```ts
userGroupId?: string;
```

- [ ] **Step 3: Re-export from `sidebar-constants.ts`**

Add to `src/renderer/src/components/sidebar-constants.ts`:

```ts
export { USER_GROUP_COLORS, type UserGroupColor } from '../../../shared/group-colors';
```

- [ ] **Step 4: Commit**

```bash
git add src/shared/group-colors.ts src/shared/types.ts src/renderer/src/components/sidebar-constants.ts
git commit -m "feat: add UserGroup type, group-colors shared module"
```

---

### Task 2: Add user group store actions

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add `UserGroupColor` import**

Add at the top of `workspace-store.ts`:

```ts
import type { UserGroupColor } from '../../../shared/group-colors';
```

- [ ] **Step 2: Add actions to `WorkspaceStore` type**

Add after `renameWorktreeGroup` (line 255):

```ts
// User group actions
createUserGroup: (name: string, color: UserGroupColor, tabId: string) => void;
deleteUserGroup: (groupId: string) => void;
renameUserGroup: (groupId: string, name: string) => void;
recolorUserGroup: (groupId: string, color: UserGroupColor) => void;
setTabUserGroup: (tabId: string, groupId: string | undefined) => void;
toggleUserGroupCollapsed: (groupId: string) => void;
reorderUserGroup: (groupId: string, toIndex: number) => void;
```

- [ ] **Step 3: Implement `createUserGroup`**

Add inside `create<WorkspaceStore>((set, get) => ({` block, after `renameWorktreeGroup`:

```ts
createUserGroup: (name, color, tabId) => {
  const group: UserGroup = { id: generateId(), name, color, collapsed: false };
  set((state) => ({
    workspace: {
      ...state.workspace,
      userGroups: [...(state.workspace.userGroups ?? []), group],
      tabs: state.workspace.tabs.map((t) =>
        t.id === tabId ? { ...t, userGroupId: group.id } : t
      )
    },
    isDirty: true
  }));
},
```

- [ ] **Step 4: Implement `deleteUserGroup`**

```ts
deleteUserGroup: (groupId) => {
  set((state) => ({
    workspace: {
      ...state.workspace,
      userGroups: (state.workspace.userGroups ?? []).filter((g) => g.id !== groupId),
      tabs: state.workspace.tabs.map((t) =>
        t.userGroupId === groupId ? { ...t, userGroupId: undefined } : t
      )
    },
    isDirty: true
  }));
},
```

- [ ] **Step 5: Implement `renameUserGroup`**

```ts
renameUserGroup: (groupId, name) => {
  set((state) => ({
    workspace: {
      ...state.workspace,
      userGroups: (state.workspace.userGroups ?? []).map((g) =>
        g.id === groupId ? { ...g, name } : g
      )
    },
    isDirty: true
  }));
},
```

- [ ] **Step 6: Implement `recolorUserGroup`**

```ts
recolorUserGroup: (groupId, color) => {
  set((state) => ({
    workspace: {
      ...state.workspace,
      userGroups: (state.workspace.userGroups ?? []).map((g) =>
        g.id === groupId ? { ...g, color } : g
      )
    },
    isDirty: true
  }));
},
```

- [ ] **Step 7: Implement `setTabUserGroup`**

```ts
setTabUserGroup: (tabId, groupId) => {
  set((state) => {
    const tabs = state.workspace.tabs.map((t) =>
      t.id === tabId ? { ...t, userGroupId: groupId } : t
    );
    let userGroups = state.workspace.userGroups ?? [];
    if (groupId === undefined) {
      const oldTab = state.workspace.tabs.find((t) => t.id === tabId);
      if (oldTab?.userGroupId) {
        const stillHasMembers = tabs.some(
          (t) => t.id !== tabId && t.userGroupId === oldTab.userGroupId
        );
        if (!stillHasMembers) {
          userGroups = userGroups.filter((g) => g.id !== oldTab.userGroupId);
        }
      }
    }
    return {
      workspace: { ...state.workspace, tabs, userGroups },
      isDirty: true
    };
  });
},
```

- [ ] **Step 8: Implement `toggleUserGroupCollapsed`**

```ts
toggleUserGroupCollapsed: (groupId) => {
  set((state) => ({
    workspace: {
      ...state.workspace,
      userGroups: (state.workspace.userGroups ?? []).map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
      )
    },
    isDirty: true
  }));
},
```

- [ ] **Step 9: Implement `reorderUserGroup`**

```ts
reorderUserGroup: (groupId, toIndex) => {
  set((state) => {
    const groups = [...(state.workspace.userGroups ?? [])];
    const fromIndex = groups.findIndex((g) => g.id === groupId);
    if (fromIndex === -1 || fromIndex === toIndex) return state;
    const [moved] = groups.splice(fromIndex, 1);
    groups.splice(toIndex, 0, moved);
    return {
      workspace: { ...state.workspace, userGroups: groups },
      isDirty: true
    };
  });
},
```

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat: add user group store actions"
```

---

### Task 3: Create `ColorPalettePicker` component

**Files:**
- Create: `src/renderer/src/components/ColorPalettePicker.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { USER_GROUP_COLORS, type UserGroupColor } from './sidebar-constants';

type ColorPalettePickerProps = {
  selected: UserGroupColor;
  onSelect: (color: UserGroupColor) => void;
};

const COLOR_MAP: Record<UserGroupColor, string> = {
  blue: 'bg-blue-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  pink: 'bg-pink-500',
  purple: 'bg-purple-500'
};

export function ColorPalettePicker({ selected, onSelect }: ColorPalettePickerProps): React.JSX.Element {
  return (
    <div className="flex gap-1.5 p-1.5">
      {USER_GROUP_COLORS.map((color) => (
        <button
          key={color}
          className={`w-5 h-5 rounded-full ${COLOR_MAP[color]} ${
            color === selected ? 'ring-2 ring-white ring-offset-1 ring-offset-fleet-surface-2' : ''
          } hover:scale-110 transition-transform`}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(color);
          }}
          title={color}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/ColorPalettePicker.tsx
git commit -m "feat: add ColorPalettePicker component"
```

---

### Task 4: Add group context menu items and border to `TabItem`

**Files:**
- Modify: `src/renderer/src/components/TabItem.tsx`

- [ ] **Step 1: Add new props to `TabItemProps`**

Add after `indentLevel` (line 51):

```ts
userGroupColor?: string;
userGroupId?: string;
userGroups?: Array<{ id: string; name: string; color: string }>;
onCreateGroup?: () => void;
onAddToGroup?: (groupId: string) => void;
onRemoveFromGroup?: () => void;
```

- [ ] **Step 2: Destructure new props**

Add to destructured parameters after `indentLevel = 0` (line 105):

```ts
userGroupColor,
userGroupId,
userGroups,
onCreateGroup,
onAddToGroup,
onRemoveFromGroup
```

- [ ] **Step 3: Add user group left border to active/inactive styles**

Replace the two class strings for active/inactive (lines 189-193):

Current:
```
${
  isActive
    ? `bg-fleet-surface-3 text-fleet-text ${indentLevel > 0 ? '' : `border-l-2 ${activeBorderColor}`}`
    : `text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text ${indentLevel > 0 ? '' : 'border-l-2 border-transparent'}`
}
```

New:
```
${
  isActive
    ? `bg-fleet-surface-3 text-fleet-text ${indentLevel > 0 ? '' : `border-l-2 ${activeBorderColor}`} ${userGroupColor ? userGroupColor : ''}`
    : `text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text ${indentLevel > 0 ? '' : 'border-l-2 border-transparent'} ${userGroupColor ? userGroupColor : ''}`
}
```

- [ ] **Step 4: Add context menu items**

After the "Create Worktree" context menu block (before the `<ContextMenu.Separator>` on line 353), insert:

```tsx
{onCreateGroup && (
  <>
    <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
    <ContextMenu.Item
      className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
      onSelect={onCreateGroup}
    >
      New Group
    </ContextMenu.Item>
  </>
)}
{onAddToGroup && userGroups && userGroups.length > 0 && (
  <ContextMenu.Sub>
    <ContextMenu.SubTrigger className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 data-[state=open]:bg-fleet-surface-3 flex items-center justify-between">
      Add to Group
      <svg className="ml-2" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 2l4 4-4 4" />
      </svg>
    </ContextMenu.SubTrigger>
    <ContextMenu.Portal>
      <ContextMenu.SubContent className="min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50">
        {userGroups.map((g) => (
          <ContextMenu.Item
            key={g.id}
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 flex items-center gap-2"
            onSelect={() => onAddToGroup(g.id)}
          >
            <span className={`w-2.5 h-2.5 rounded-full bg-${g.color}-500`} />
            {g.name}
          </ContextMenu.Item>
        ))}
      </ContextMenu.SubContent>
    </ContextMenu.Portal>
  </ContextMenu.Sub>
)}
{onRemoveFromGroup && userGroupId && (
  <ContextMenu.Item
    className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
    onSelect={onRemoveFromGroup}
  >
    Remove from Group
  </ContextMenu.Item>
)}
```

IMPORTANT: Add a `<ContextMenu.Separator>` between the user group items and the existing "Close Tab" separator if user group items are present. The safest approach is to check -- if `onCreateGroup || (onAddToGroup && userGroups && userGroups.length > 0) || (onRemoveFromGroup && userGroupId)` is true, render a separator before the user group items too. But actually, looking at the existing code, the separator at line 353 already exists. We should insert our items between the worktree section separator and the existing closing separator.

The exact placement: after the worktree section's `</>` closing fragment (line 352), before the existing `<ContextMenu.Separator>` (line 353). The user group section will have its own separator at the start (already included above). So the structure becomes:

```
{Rename, Reset...}
{Create Worktree section}
<Separator>           ← existing line 353
{New Group}
{Add to Group submenu}
{Remove from Group}
<Separator>           ← existing line 353 (moved)
{Close Tab}
```

Wait, there's a conflict: line 353 already has a separator. We need to add another one before Close Tab. The cleanest approach: conditionally render the user group items with their own separator at the bottom, and always show the existing separator before Close Tab.

Update: insert AFTER the separator on line 353 (before the Close Tab item):

```tsx
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
          {onCreateGroup && (
            <ContextMenu.Item
              className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
              onSelect={onCreateGroup}
            >
              New Group
            </ContextMenu.Item>
          )}
          {onAddToGroup && userGroups && userGroups.length > 0 && (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 data-[state=open]:bg-fleet-surface-3 flex items-center justify-between">
                Add to Group
                <svg className="ml-2" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 2l4 4-4 4" />
                </svg>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className="min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50">
                  {userGroups.map((g) => (
                    <ContextMenu.Item
                      key={g.id}
                      className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 flex items-center gap-2"
                      onSelect={() => onAddToGroup(g.id)}
                    >
                      <span className={`w-2.5 h-2.5 rounded-full bg-${g.color}-500`} />
                      {g.name}
                    </ContextMenu.Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}
          {onRemoveFromGroup && userGroupId && (
            <ContextMenu.Item
              className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
              onSelect={onRemoveFromGroup}
            >
              Remove from Group
            </ContextMenu.Item>
          )}
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/TabItem.tsx
git commit -m "feat: add user group context menu items and border to TabItem"
```

---

### Task 5: Render user groups in `Sidebar` + update DnD

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports**

Add after existing imports (around line 38):

```tsx
import { USER_GROUP_COLORS, type UserGroupColor } from './sidebar-constants';
import { ColorPalettePicker } from './ColorPalettePicker';
```

- [ ] **Step 2: Add store destructuring for new actions**

Add to `useWorkspaceStore(useShallow(...))` call after `setSidebarWidth` (line 550):

```tsx
createUserGroup: s.createUserGroup,
deleteUserGroup: s.deleteUserGroup,
renameUserGroup: s.renameUserGroup,
recolorUserGroup: s.recolorUserGroup,
setTabUserGroup: s.setTabUserGroup,
toggleUserGroupCollapsed: s.toggleUserGroupCollapsed,
reorderUserGroup: s.reorderUserGroup,
```

And add to destructured const (after `setSidebarWidth`):

```tsx
createUserGroup,
deleteUserGroup,
renameUserGroup,
recolorUserGroup,
setTabUserGroup,
toggleUserGroupCollapsed,
reorderUserGroup,
```

- [ ] **Step 3: Update `dragType` state**

Change line 564 from:

```tsx
const [dragType, setDragType] = useState<'tab' | 'group'>('tab');
```

To:

```tsx
const [dragType, setDragType] = useState<'tab' | 'group' | 'userGroup'>('tab');
```

- [ ] **Step 4: Add "New Group" popover state**

Add after the DnD state:

```tsx
const [newGroupState, setNewGroupState] = useState<{ tabId: string } | null>(null);
const [newGroupName, setNewGroupName] = useState('');
const [newGroupColor, setNewGroupColor] = useState<UserGroupColor>('blue');
```

- [ ] **Step 5: Add `UserGroupHeader` component**

Add before the existing `GroupHeader` function (before line 64):

```tsx
function UserGroupHeader({
  group,
  tabCount,
  onToggle,
  onRename,
  onRecolor,
  onUngroupAll,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver
}: {
  group: { id: string; name: string; color: string; collapsed: boolean };
  tabCount: number;
  onToggle: () => void;
  onRename: (name: string) => void;
  onRecolor: (color: UserGroupColor) => void;
  onUngroupAll: () => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  isDragOver: 'above' | 'below' | null;
}): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(group.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== group.name) {
      onRename(trimmed);
    }
    setIsEditing(false);
  }, [editValue, group.name, onRename]);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          className="group/ugroup flex items-center gap-1.5 px-2 py-2 mt-2 cursor-pointer rounded-md text-xs text-fleet-text-secondary hover:text-fleet-text hover:bg-fleet-surface-2/50 transition-colors relative select-none"
          onClick={onToggle}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'userGroup');
            onDragStart();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            onDragOver(e);
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDrop();
          }}
        >
          {isDragOver === 'above' && (
            <div className="absolute top-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full -translate-y-0.5" />
          )}
          {isDragOver === 'below' && (
            <div className="absolute bottom-0 left-1 right-1 h-0.5 bg-blue-500 rounded-full translate-y-0.5" />
          )}
          <span className={`w-2 h-2 rounded-full bg-${group.color}-500 flex-shrink-0`} />
          <ChevronRight
            size={12}
            className={`transition-transform flex-shrink-0 ${group.collapsed ? '' : 'rotate-90'}`}
          />
          {isEditing ? (
            <input
              ref={inputRef}
              className="flex-1 bg-fleet-surface-3 text-fleet-text text-xs rounded px-1 py-0 outline-none border border-blue-500 min-w-0"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              onBlur={commitRename}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span
              className="truncate"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditValue(group.name);
                setIsEditing(true);
              }}
            >
              {group.name}
            </span>
          )}
          <span className="ml-auto text-[10px] text-fleet-text-subtle">
            {group.collapsed ? `${tabCount} tabs` : ''}
          </span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={`min-w-[140px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 text-sm text-fleet-text z-50 ${popperAnim}`}
        >
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3"
            onSelect={() => {
              setEditValue(group.name);
              setTimeout(() => setIsEditing(true), 0);
            }}
          >
            Rename
          </ContextMenu.Item>
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-fleet-surface-3 hover:bg-fleet-surface-3 data-[state=open]:bg-fleet-surface-3 flex items-center justify-between">
              Recolor
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="min-w-[180px] bg-fleet-surface-2 border border-fleet-border-strong rounded-md shadow-lg p-1 z-50">
                <ColorPalettePicker selected={group.color as UserGroupColor} onSelect={onRecolor} />
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
          <ContextMenu.Separator className="my-1 h-px bg-fleet-surface-3" />
          <ContextMenu.Item
            className="px-2 py-1.5 rounded cursor-pointer outline-none focus:bg-red-900/50 hover:bg-red-900/50 text-red-400"
            onSelect={onUngroupAll}
          >
            Ungroup All
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
```

- [ ] **Step 6: Update `handleDragOver` for user group drags**

Add after the existing `if (dragType === 'group')` block (after line 604):

```tsx
if (dragType === 'userGroup') {
  if (!isGroupHeader) {
    setDropTarget(null);
    return;
  }
}
```

- [ ] **Step 7: Update `handleDrop` for user group reordering**

In the `handleDrop` callback, add after the group drag handling block (after `reorderGroup(draggedTab.groupId, toIndex);` on line 640):

```tsx
} else if (dragType === 'userGroup' && draggedTab?.userGroupId) {
  const userGroups = workspace.userGroups ?? [];
  const ugIndex = userGroups.findIndex((g) => g.id === draggedTab.userGroupId);
  const toIndex = dropTarget.position === 'below' ? dropTarget.index + 1 : dropTarget.index;
  reorderUserGroup(draggedTab.userGroupId, ugIndex !== toIndex ? toIndex : ugIndex);
  setDragIndex(null);
  setDropTarget(null);
  return;
```

- [ ] **Step 8: Rewrite the tab rendering IIFE**

Replace the entire IIFE block (lines 1214-1375) with user-group-aware rendering:

```tsx
{(() => {
  const regularTabs = workspace.tabs.filter(
    (t) =>
      t.type !== 'images' &&
      t.type !== 'settings' &&
      t.type !== 'annotate' &&
      t.type !== 'kanban' &&
      t.type !== 'sessions'
  );

  const rendered: React.ReactNode[] = [];
  const seenWorktreeGroups = new Set<string>();
  const userGroups = workspace.userGroups ?? [];

  const renderTabWithWorktreeGroups = (tab: typeof regularTabs[number]): void => {
    if (tab.groupId && !seenWorktreeGroups.has(tab.groupId)) {
      seenWorktreeGroups.add(tab.groupId);
      const groupTabs = regularTabs.filter((t) => t.groupId === tab.groupId);
      const parentTab = groupTabs.find((t) => t.groupRole === 'parent');
      const isCollapsed = collapsedGroups.has(tab.groupId);
      const groupId = tab.groupId;
      const firstTabIdx = realIndex(groupTabs[0]!.id);

      rendered.push(
        <GroupHeader
          key={`group-${groupId}`}
          label={groupTabs[0]!.groupLabel ?? parentTab?.label ?? 'Worktree Group'}
          tabCount={groupTabs.length}
          isCollapsed={isCollapsed}
          onToggle={() => toggleGroupCollapsed(groupId)}
          onRename={(newLabel) => renameWorktreeGroup(groupId, newLabel)}
          onAddWorktree={() => {
            const anyTab = groupTabs[0]!;
            const firstPane = collectPaneIds(anyTab.splitRoot)[0];
            const cwd = (firstPane ? liveCwds.get(firstPane) : undefined) ?? anyTab.cwd;
            void handleCreateWorktree(anyTab.id, cwd, getPaneContextById(firstPane));
          }}
          onDragStart={() => handleDragStart(firstTabIdx, 'group')}
          onDragOver={(e) => handleDragOver(e, firstTabIdx, true)}
          onDrop={() => handleDrop()}
          isDragOver={
            dropTarget?.index === firstTabIdx && dropTarget.isGroupHeader
              ? dropTarget.position
              : null
          }
        />
      );
    }

    if (tab.groupId && collapsedGroups.has(tab.groupId)) return;

    const paneIds = collectPaneIds(tab.splitRoot);
    const isFile =
      tab.type === 'file' ||
      tab.type === 'image' ||
      tab.type === 'markdown' ||
      tab.type === 'pdf';
    const idx = realIndex(tab.id);

    let displayCwd: string;
    let drivingPaneId: string | undefined;
    if (isFile) {
      const leafs = collectPaneLeafs(tab.splitRoot);
      const filePath = leafs[0]?.filePath ?? '';
      displayCwd = filePath ? filePath.split('/').slice(0, -1).join('/') || '/' : '/';
    } else {
      drivingPaneId =
        tab.id === activeTabId && activePaneId && paneIds.includes(activePaneId)
          ? activePaneId
          : paneIds[0];
      displayCwd = tab.cwd;
    }

    const isFileDirty =
      isFile && collectPaneLeafs(tab.splitRoot).some((l) => l.isDirty === true);
    const displayLabel = isFile && isFileDirty ? tab.label + ' *' : tab.label;

    let icon: React.ReactNode;
    if (tab.type === 'pi') {
      icon = <Bot size={14} />;
    } else if (isFile) {
      const leafs2 = collectPaneLeafs(tab.splitRoot);
      const fileBasename = leafs2[0]?.filePath?.split('/').pop() ?? tab.label;
      icon =
        tab.type === 'image' ? <ImageIcon size={14} /> : getFileIcon(fileBasename, 14);
    } else {
      icon = <Terminal size={14} />;
    }

    const ug = userGroups.find((g) => g.id === tab.userGroupId);
    const userGroupColorClass = ug ? `border-l-2 border-l-${ug.color}-500/50` : undefined;

    const userGroupList = userGroups.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color
    }));

    rendered.push(
      <TabItem
        key={tab.id}
        id={tab.id}
        label={displayLabel}
        labelIsCustom={tab.labelIsCustom ?? false}
        cwd={displayCwd}
        drivingPaneId={drivingPaneId}
        isActive={tab.id === activeTabId}
        badge={getTabBadge(paneIds)}
        icon={icon}
        disableReset={isFile}
        index={idx}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        isDragOver={
          dropTarget?.index === idx && !dropTarget.isGroupHeader
            ? dropTarget.position
            : null
        }
        indentLevel={tab.groupId ? 1 : 0}
        worktreeBranch={tab.worktreeBranch}
        pathContext={tab.pathContext}
        worktreeDisabledReason={
          isFile
            ? undefined
            : tab.groupRole === 'worktree'
              ? 'Already a worktree'
              : tab.groupId
                ? 'Worktrees already created'
                : !gitRepoTabs.has(tab.id)
                  ? 'Not a git repository'
                  : null
        }
        onCreateWorktree={
          !isFile && gitRepoTabs.has(tab.id) && !tab.worktreePath && !tab.groupId
            ? () => {
                const firstPane = collectPaneIds(tab.splitRoot)[0];
                const liveCwd = firstPane ? liveCwds.get(firstPane) : undefined;
                void handleCreateWorktree(
                  tab.id,
                  liveCwd ?? tab.cwd,
                  getPaneContextById(firstPane)
                );
              }
            : undefined
        }
        onClick={() => {
          setActiveTab(tab.id);
          if (!isFile) {
            for (const paneId of paneIds) {
              useNotificationStore.getState().clearPane(paneId);
              window.fleet.notifications.paneFocused({ paneId });
            }
          }
        }}
        onDuplicate={
          !isFile && (!tab.type || tab.type === 'terminal' || tab.type === 'pi')
            ? () => duplicateTab(tab.id)
            : undefined
        }
        onClose={() => handleCloseTab(tab.id)}
        onRename={(newLabel) => renameTab(tab.id, newLabel)}
        onResetLabel={(liveCwd) => resetTabLabel(tab.id, liveCwd)}
        userGroupColor={userGroupColorClass}
        userGroupId={tab.userGroupId}
        userGroups={userGroupList}
        onCreateGroup={
          tab.userGroupId
            ? undefined
            : () => {
                setNewGroupState({ tabId: tab.id });
                setNewGroupName('');
                setNewGroupColor('blue');
              }
        }
        onAddToGroup={
          userGroups.length > 0 && !tab.userGroupId
            ? (groupId) => setTabUserGroup(tab.id, groupId)
            : undefined
        }
        onRemoveFromGroup={
          tab.userGroupId
            ? () => setTabUserGroup(tab.id, undefined)
            : undefined
        }
      />
    );
  };

  // 1. Ungrouped tabs render first
  for (const tab of regularTabs.filter((t) => !t.userGroupId)) {
    renderTabWithWorktreeGroups(tab);
  }

  // 2. User groups
  for (const ug of userGroups) {
    const groupTabs = regularTabs.filter((t) => t.userGroupId === ug.id);
    if (groupTabs.length === 0) continue;

    const firstTabIdx = realIndex(groupTabs[0]!.id);

    rendered.push(
      <UserGroupHeader
        key={`ug-${ug.id}`}
        group={ug}
        tabCount={groupTabs.length}
        onToggle={() => toggleUserGroupCollapsed(ug.id)}
        onRename={(name) => renameUserGroup(ug.id, name)}
        onRecolor={(color) => recolorUserGroup(ug.id, color)}
        onUngroupAll={() => {
          for (const t of groupTabs) setTabUserGroup(t.id, undefined);
        }}
        onDragStart={() => handleDragStart(firstTabIdx, 'userGroup')}
        onDragOver={(e) => handleDragOver(e, firstTabIdx, true)}
        onDrop={() => handleDrop()}
        isDragOver={
          dropTarget?.index === firstTabIdx && dropTarget.isGroupHeader
            ? dropTarget.position
            : null
        }
      />
    );

    if (ug.collapsed) continue;

    for (const tab of groupTabs) {
      renderTabWithWorktreeGroups(tab);
    }
  }

  return rendered;
})()}
```

- [ ] **Step 9: Add "New Group" popover markup**

Add after the tab-list scroll div (after the rendering IIFE, before `</div>` of the tabListRef div, around line 1376):

```tsx
{newGroupState && (
  <div className="px-2 py-2 bg-fleet-surface-2 border border-fleet-border-strong rounded-md mx-1 mb-2">
    <input
      autoFocus
      className="w-full bg-fleet-surface-3 text-fleet-text text-sm rounded px-2 py-1 outline-none border border-fleet-border-strong mb-2"
      placeholder="Group name..."
      value={newGroupName}
      onChange={(e) => setNewGroupName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const name = newGroupName.trim() || 'Group';
          createUserGroup(name, newGroupColor, newGroupState.tabId);
          setNewGroupState(null);
        }
        if (e.key === 'Escape') setNewGroupState(null);
      }}
    />
    <ColorPalettePicker selected={newGroupColor} onSelect={setNewGroupColor} />
    <div className="flex justify-end gap-1.5 mt-1.5">
      <button
        className="px-2 py-0.5 text-xs text-fleet-text-muted hover:text-fleet-text rounded transition"
        onClick={() => setNewGroupState(null)}
      >
        Cancel
      </button>
      <button
        className="px-2 py-0.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition"
        onClick={() => {
          const name = newGroupName.trim() || 'Group';
          createUserGroup(name, newGroupColor, newGroupState.tabId);
          setNewGroupState(null);
        }}
      >
        Create
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat: render user tab groups with DnD in sidebar"
```

---

### Task 6: Type check, lint, and verify

**Files:** none

- [ ] **Step 1: Run type check**

```bash
npm run typecheck
```

Expected: PASS with no errors.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: PASS with no errors.

- [ ] **Step 3: Commit any fixes**

If type or lint errors were fixed:

```bash
git add -A
git commit -m "fix: typecheck and lint fixes for user tab groups"
```

---

## Plan Self-Review

### Spec Coverage
- Data model (UserGroup type, Workspace changes, Tab changes, color palette, persistence): **Task 1**
- Store actions (all 7): **Task 2**
- ColorPalettePicker component: **Task 3**
- TabItem UI changes (border, context menu): **Task 4**
- Sidebar rendering (UserGroupHeader, ungrouped section, rendering order): **Task 5**
- Drag-and-drop modifications (userGroup drag type, reorder, tab DnD): **Task 5** (Steps 3, 6, 7)
- Edge cases (auto-delete empty group via `setTabUserGroup`, collapsed rendering): **Task 2** (Step 7), **Task 5** (Step 8)
- Verification (typecheck, lint): **Task 6**

### Placeholder Scan
- No TBD, TODO, or incomplete sections.
- All code steps contain actual code (no "similar to Task N" references).
- All commands specify exact expected output.

### Type Consistency
- `UserGroupColor` defined in `src/shared/group-colors.ts`, imported in `types.ts` and `workspace-store.ts`.
- `USER_GROUP_COLORS` const available in both shared and renderer.
- `ColorPalettePicker` uses `UserGroupColor` from `sidebar-constants` (re-exported).
- All store action names match between type declarations and implementations.
- All prop names match between `TabItemProps` additions and `Sidebar.tsx` call sites.
