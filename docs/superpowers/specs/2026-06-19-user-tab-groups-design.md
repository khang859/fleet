# User-Created Tab Groups

Groups tabs in the sidebar into collapsible, color-coded named sections for organization — like Chrome tab groups.

## Requirements

- **Purpose:** Collapse/expand for sidebar organization. No bulk actions, no workspace isolation.
- **Creation:** Right-click context menu on tabs → "New Group" or "Add to Group" → submenu of existing groups.
- **Identity:** Custom name + color dot (8-color palette).
- **Worktree interaction:** Separate systems. A tab can be in both a user group and a worktree group (nesting). Both visual indicators show.
- **Scope:** Per-workspace.
- **Empty groups:** Auto-delete when last tab is removed.

## Data Model

### New type (`src/shared/types.ts`)

```ts
type UserGroup = {
  id: string            // crypto.randomUUID()
  name: string          // user-provided label
  color: UserGroupColor // one of 8 palette colors
  collapsed: boolean    // sidebar collapse state
}
```

### Changes to `Workspace`

```ts
type Workspace = {
  // ... existing fields
  userGroups: UserGroup[]  // ordered — defines sidebar display order
}
```

### Changes to `Tab`

```ts
type Tab = {
  // ... existing fields
  userGroupId?: string  // references a UserGroup.id, undefined = ungrouped
}
```

### Color palette (`src/renderer/src/components/sidebar-constants.ts`)

```ts
export const USER_GROUP_COLORS = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple'] as const;
export type UserGroupColor = typeof USER_GROUP_COLORS[number];
```

Each maps to `bg-{color}-500` for the dot and `border-l-{color}-500/50` for the tab left border.

### Persistence

`userGroups[]` and `tab.userGroupId` persist with the workspace via `LayoutStore`. No migration needed — new optional fields default to absent.

## Store Actions

All in `useWorkspaceStore`. All set `isDirty: true`.

| Action | Signature | Behavior |
|---|---|---|
| `createUserGroup` | `(name, color, tabId)` | Creates `UserGroup`, assigns the given tab to it. |
| `deleteUserGroup` | `(groupId)` | Clears `userGroupId` from all member tabs, removes group. |
| `renameUserGroup` | `(groupId, name)` | Updates `userGroups[idx].name`. |
| `recolorUserGroup` | `(groupId, color)` | Updates `userGroups[idx].color`. |
| `setTabUserGroup` | `(tabId, groupId \| undefined)` | Assigns tab to a group or removes it. Auto-deletes group if it becomes empty. |
| `toggleUserGroupCollapsed` | `(groupId)` | Toggles `collapsed`. |
| `reorderUserGroup` | `(groupId, toIndex)` | Splice group position in `userGroups` array. |

## UI Components

### Sidebar.tsx changes

**`UserGroupHeader`** (new inline component):
- Color dot (`bg-{color}-500`, 8px circle) + group name + tab count badge + collapse chevron + drag handle
- Double-click name to rename inline
- Right-click context menu: Rename, Recolor (palette submenu), Ungroup All
- Draggable as group-drag type for reordering groups

**Ungrouped section:**
- Tabs without `userGroupId` render at the top, before all groups
- Not collapsible (always visible)
- Hidden when all tabs are grouped

**Rendering order:**
1. Ungrouped tabs
2. `UserGroupHeader` + member tabs (for each group in `workspace.userGroups` order)
3. Within each group: worktree `GroupHeader` + tabs (as today)
4. Collapsed groups hide their tab items entirely

### TabItem.tsx changes

- When `userGroupId` is set: show `border-l-2 border-l-{color}-500/50` left border (alongside any worktree teal border)
- Context menu additions:
  - "New Group" — opens a small popover near the right-click position with a name text input and 8-color palette grid. Confirm creates the group and assigns the tab. Cancel dismisses.
  - "Add to Group" — submenu of existing groups with color dots and names. Hidden when no groups exist.
  - "Remove from Group" — when currently grouped, clears `userGroupId`.

### New component: `ColorPalettePicker.tsx`

Small popover grid of 8 color circles. Used by "New Group" dialog and "Recolor" context menu submenu.

### Drag-and-drop modifications

- New drag type: `'userGroup'` (alongside `'tab'` and `'group'`)
- Tab drag between groups: `setTabUserGroup(tabId, targetGroupId)`. Dragging to ungrouped area clears `userGroupId`. Auto-delete group if it becomes empty.
- Tab drag within its own group: reorders the tab within the group (standard reorder, no group change).
- Group header drag: `reorderUserGroup(groupId, toIndex)`
- Worktree DnD rules still apply within groups

## Edge Cases

| Scenario | Behavior |
|---|---|
| Empty group (last tab removed) | Auto-delete group |
| All tabs in a group are closed | Group auto-deleted |
| Undo close tab that was in a group | Restored tab keeps `userGroupId`. If group was deleted, tab reverts to ungrouped. |
| Worktree tab inside user group | Both visual indicators: user group's colored left border + worktree's teal border + worktree branch subtitle |
| Drag grouped tab outside its group | Tab gets ungrouped. If group becomes empty, auto-delete. |

## Verification

- Type check: `npm run typecheck`
- Lint: `npm run lint`
- Manual testing: create groups, collapse/expand, rename, recolor, drag tabs between groups, verify persistence across app restart and workspace switch