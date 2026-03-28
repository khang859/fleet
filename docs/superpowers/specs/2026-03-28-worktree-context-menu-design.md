# Always-Visible "Create Worktree" Context Menu Item

## Problem

The "Create Worktree" context menu item on tabs conditionally appears/disappears based on whether the tab is a git repo, is already a worktree, or is in a group. This violates Baymard's research on disappearing UI elements — users wonder why the option appears for some tabs but not others, creating confusion and reducing discoverability.

## Solution

Always show the "Create Worktree" item on all terminal tabs. When the action isn't available, render it disabled with a subtitle explaining why.

## Props Change

Replace `onCreateWorktree?: () => void` + `isWorktreeChild?: boolean` on `TabItemProps` with:

```typescript
onCreateWorktree?: () => void;
worktreeDisabledReason?: string | null; // null = enabled, string = disabled with reason
```

## Disabled Reason Logic (Sidebar.tsx)

| Condition | `worktreeDisabledReason` |
|---|---|
| Terminal tab, git repo, standalone | `null` (enabled) |
| Terminal tab, not a git repo | `"Not a git repository"` |
| Worktree child tab | `"Already a worktree"` |
| Parent tab already in a group | `"Worktrees already created"` |
| Non-terminal tab (file, settings, etc.) | Item not rendered at all |

## Context Menu Rendering (TabItem.tsx)

The item always renders for terminal tabs (when `worktreeDisabledReason !== undefined`).

**Enabled state** (`worktreeDisabledReason === null`):
- `GitBranch` icon from lucide-react + "Create Worktree" text
- Normal interactive styling (hover highlight, cursor pointer)
- Calls `onCreateWorktree` on select

**Disabled state** (`worktreeDisabledReason` is a string):
- `GitBranch` icon + "Create Worktree" text, both dimmed (`text-neutral-500`)
- No hover highlight, no pointer cursor
- Subtitle line below in smaller dimmer text showing the reason
- Click does nothing

## Non-terminal Tabs

File, image, settings, star-command, crew tabs do not show the item at all. These aren't terminals — the option would be pure noise, not a discoverable feature.

## Files to Modify

1. `src/renderer/src/components/TabItem.tsx` — Update props, render always-visible disabled/enabled item
2. `src/renderer/src/components/Sidebar.tsx` — Compute `worktreeDisabledReason` and pass it instead of conditional `onCreateWorktree`
