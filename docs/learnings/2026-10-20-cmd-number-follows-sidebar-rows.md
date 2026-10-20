# Learnings: Cmd+1-9 must count the sidebar rows, not `workspace.tabs` (2026-10-20)

## Problem

`Cmd+1-9` picked the Nth entry of `workspace.tabs` (minus pinned tools).
The sidebar does not draw tabs in that order.
Ungrouped tabs come first, then user groups, agents live in their own section further down, and session files hang under their session.
With `T1, T2 (in a group), Scratch chat, T3, T4`, the sidebar shows `T1, T3, T4, T2, Scratch chat`, but `Cmd+2` opened `T2` and `Cmd+3` opened the scratch chat.

## Fix

`use-pane-navigation.ts` now reads the Nth `[data-tab-id]` row off the DOM via `sidebarRowIds()`, the same source the Up/Down arrows already used.
`MiniTabButton` in `App.tsx` carries `data-tab-id` too, so the collapsed icon rail works the same way.
Tabs inside a folded group or a folded section are not rows, so the keys skip them, which matches what the user sees.
The old `getNormalTabs()` filter was removed.

## Takeaway

Any shortcut that means "the Nth / next tab" has to use the order the user sees.
Only the rendered sidebar knows that order, so read it from `[data-tab-id]` rather than re-deriving it from the store.
