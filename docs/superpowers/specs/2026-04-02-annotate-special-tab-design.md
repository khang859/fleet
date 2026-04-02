# Annotate Special Tab Design

**Date:** 2026-04-02
**Status:** Draft

## Summary

Make the Annotate tab a first-class special tab in the sidebar, matching the treatment of the Images tab. Users should not be able to close, drag, or reorder it. It should be visually differentiated with a dedicated card component and teal accent color. Additionally, document `fleet annotate` in the injected skill doc.

## Current State

- Annotate is already a tab type (`type: 'annotate'`) with auto-creation via `ensureAnnotateTab()`.
- `getNormalTabs()` already excludes it from Cmd+1-9 navigation.
- **Problem:** The sidebar renders it as a regular `TabItem` — draggable, closable, visually identical to terminal/file tabs.
- **Problem:** `resources/skills/fleet.md` documents `fleet open` and `fleet images` but not `fleet annotate`.

## Design

### 1. `AnnotateTabCard` Component

A new component in `Sidebar.tsx` alongside `ImagesTabCard`.

**Visual design:**
- Same structural pattern as `ImagesTabCard`: card container with icon + label
- **Teal accent color** when active:
  - Border: `rgba(45,212,191,0.35)`
  - Glow: `rgba(45,212,191,0.15)`
  - Label text: `rgb(94,234,212)` (active) / `rgba(94,234,212,0.5)` (inactive)
- **Icon:** Annotation/pen SVG in 8×8 thumbnail area, teal-colored
- **Label:** "Annotate" in uppercase mono tracking (matching Images' `9px` style)
- **Minimal:** No stats, no subtitle — just icon and label
- **No close button, no drag handle** — click target only

**Props:** `isActive: boolean`, `onClick: () => void` (same interface as `ImagesTabCard`)

### 2. Sidebar Rendering Changes

In `Sidebar.tsx` tab rendering section (~line 1000):

1. After the Images tab card rendering block, add an identical block for Annotate tabs using `AnnotateTabCard`.
2. The divider (`h-px`) renders after both special cards.
3. Add `t.type !== 'annotate'` to the `regularTabs` filter (line 1013-1017) so Annotate no longer renders as a `TabItem`.

**Rendering order:**
```
[ImagesTabCard]
[AnnotateTabCard]
─── divider ───
[regular tabs...]
```

### 3. Skill Doc Update

Add a `## fleet annotate` section to `resources/skills/fleet.md` between `fleet open` and `fleet images`, documenting:

- Purpose: visually annotate web page elements for AI agents
- Usage: `fleet annotate [url]` with `--timeout` option
- Examples: annotating localhost, external URLs, blank page

### 4. No Other Changes

The following already work correctly and need no modification:
- `ensureAnnotateTab()` in workspace-store.ts — auto-creates the tab
- `getNormalTabs()` in use-pane-navigation.ts — already excludes `annotate`
- Tab type definition in types.ts — `'annotate'` already a valid type
- `App.tsx` content rendering — already renders `<AnnotateTab />` for the type
- Workspace persistence — annotate tabs already preserved across saves
- Settings tab filtering — annotate is not filtered during save (correct behavior)

## Files to Modify

| File | Change |
|------|--------|
| `src/renderer/src/components/Sidebar.tsx` | Add `AnnotateTabCard` component; render it after Images card; filter `annotate` from `regularTabs` |
| `resources/skills/fleet.md` | Add `## fleet annotate` documentation section |
