# Learnings: Adding a pinned tool tab requires updating every "exclude tool tabs" filter (2026-06-09)

## Problem

When adding the new pinned **Sessions** tool tab (alongside Kanban/Images/Annotate), wiring `ensureSessionsTab` into the workspace migration chain made the tab appear — but it silently broke active-tab restoration and `Cmd+1-9` tab switching. The active tab would resolve to the *Sessions* tab instead of a real shell tab.

Root cause: several places filter out pinned/tool tabs by an explicit allow-list of `type`s (`images`/`annotate`/`kanban`/`settings`). A newly added pinned type is NOT excluded automatically, so it gets treated as a "normal" tab by navigation/restoration logic. An existing `workspace-store` test (`ensures ... tabs for an empty workspace`) caught it — but only the count assertion; the restoration bug was a separate seam the test surfaced indirectly.

## Fix

When adding any new pinned/tool tab `type`, update **all** of these tool-tab exclusion sites (grep for `t.type !== 'kanban'`):

- `src/renderer/src/store/workspace-store.ts` — active-tab restoration `.find()` in **both** `loadWorkspace` and `switchWorkspace` (two sites).
- `src/renderer/src/hooks/use-pane-navigation.ts` — `getNormalTabs()` (powers `Cmd+1-9`).
- `src/renderer/src/App.tsx` — mini-sidebar tab-icon filter.
- `src/renderer/src/components/Sidebar.tsx` — the `regularTabs` filter (so the pinned tab doesn't double-render in the normal tab strip).

Also wire the `ensure<Tool>Tab` helper into the migration chains (`loadWorkspace` + `switchWorkspace`) and the `App.tsx` empty-workspace fallback, mirroring `ensureImagesTab`/`ensureKanbanTab`, or the card never appears by default.

## Takeaway

The tool-tab exclusion list is duplicated across ~5 sites with no shared constant. Adding a pinned tab is not "add the tab" — it's "add the tab and teach every navigation/restoration filter to skip it." Consider centralizing into a single `isToolTab(type)` predicate to prevent the next instance of this.
