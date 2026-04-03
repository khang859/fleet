# Annotate List Quick Actions

## Summary

Add always-visible quick action buttons (Copy Path, Delete) to each annotation list item in the AnnotateTab list view.

## Current State

The list view in `src/renderer/src/components/AnnotateTab.tsx` (lines 204-260) renders each annotation as a clickable button showing URL, timestamp, and element count. The only action is clicking to navigate to the detail view. Copy Path and Delete actions only exist in the detail view header.

## Design

### Layout Change

Each list item changes from a single `<button>` to a `<div>` wrapper:
- **Left (clickable area):** URL + timestamp info — clicking navigates to detail view
- **Right (action buttons):** Two icon buttons with `stopPropagation` to prevent navigation

### Buttons

| Action | Icon | Size | Hover Style | Behavior |
|--------|------|------|-------------|----------|
| Copy Path | `ClipboardCopy` | 14px | `text-neutral-400 → text-white` | Copies `ann.dirPath` to clipboard, shows toast |
| Delete | `Trash2` | 14px | `text-neutral-400 → text-red-400` | Calls `deleteAnnotation(ann.id)` |

### Styling

- Button container: `flex items-center gap-1 flex-shrink-0`
- Each button: `p-1 text-neutral-400 rounded hover:bg-neutral-800` (matching detail view header buttons)
- List item wrapper: `flex items-center gap-2 px-3 py-2.5 hover:bg-neutral-900 border-b border-neutral-800/50`

### Behavior

- `handleCopyPath` already exists and is reused
- `deleteAnnotation` from the Zustand store is called directly (no confirmation, consistent with detail view)
- `e.stopPropagation()` on action buttons prevents navigating to detail view

## Files Modified

- `src/renderer/src/components/AnnotateTab.tsx` — list view section only (lines ~239-255)

## No Changes To

- Empty state, header, detail view, data model, IPC, store
