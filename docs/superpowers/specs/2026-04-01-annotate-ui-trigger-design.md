# Annotate UI Trigger & Results Display

**Date:** 2026-04-01
**Status:** Approved

## Summary

Add a UI surface for the annotation feature: a sidebar tab ("Annotate") showing a list of past annotations with a detail view, a trigger modal for starting new annotations with URL input, a PaneToolbar button, persistent storage in `~/.fleet/annotations/`, and configurable auto-cleanup.

Builds on the existing `AnnotateService` (main process) which handles the BrowserWindow, picker, screenshots, and result file writing.

## Annotate Sidebar Tab

New tab in the sidebar alongside terminals, Images, and Settings.

### List View

- Header with "New Annotation" button
- Rows sorted newest-first, each showing:
  - URL (truncated)
  - Relative timestamp ("2m ago", "1h ago")
  - Element count badge
- Click a row to open detail view
- Empty state: centered message + "New Annotation" button

### Detail View

- **Header:** Back button, full URL (clickable — re-opens annotation browser on that URL), timestamp, "Copy Path" and "Copy as Markdown" buttons
- **Elements list:** Each element as a card:
  - Numbered badge (1, 2, 3...)
  - Tag + selector (e.g. `button#submit-btn`)
  - Comment text (if any)
  - Screenshot thumbnail (if captured, click to expand)
  - Expandable section: box model, accessibility info, styles
- Follows existing Fleet dark theme styling (neutral-900 backgrounds, neutral-700 borders)

## Trigger Modal

Opened by clicking "New Annotation" in the Annotate tab or the PaneToolbar button.

### Layout

- Standard Fleet modal (dark overlay `bg-black/60`, centered panel)
- Title: "New Annotation"
- URL input field:
  - Auto-filled from clipboard if clipboard contains a URL (starts with `http://` or `https://`)
  - Placeholder: "https://example.com"
  - Focused on open
- "Start" button (primary) and "Cancel" button (ghost)
- Escape to close

### Behavior

1. Modal opens, reads clipboard, auto-fills URL if it looks like a URL
2. User edits URL or leaves as-is, clicks Start (or Enter)
3. Modal closes
4. Renderer sends `ANNOTATE_UI_START` IPC to main process with `{ url, timeout }`
5. Main process calls `annotateService.start()`, opens BrowserWindow
6. On completion, main process stores result in annotation store, sends `ANNOTATE_COMPLETED` IPC to renderer
7. Renderer updates Annotate tab — new annotation appears at top of list

## PaneToolbar Button

- Icon: `Crosshair` from lucide-react (or `MousePointer2`)
- Placed in the floating PaneToolbar (alongside split, git, search buttons)
- Tooltip: "Annotate webpage"
- Clicking opens the trigger modal (same modal as from the Annotate tab)

## Persistence

### Storage Location

```
~/.fleet/annotations/
  index.json
  ann-<timestamp>-<id>/
    result.json
    el1.png
    el2.png
  ann-<timestamp>-<id>/
    result.json
    el1.png
```

### Index Format

`~/.fleet/annotations/index.json`:

```json
[
  {
    "id": "ann-1712000000-abc123",
    "url": "https://example.com",
    "timestamp": 1712000000000,
    "elementCount": 3,
    "dirPath": "ann-1712000000-abc123"
  }
]
```

### AnnotationStore

New class in main process (similar to how `ImageService` tracks generation metadata):

- On startup: loads `index.json`, verifies each directory still exists (prunes stale entries), runs cleanup
- `addAnnotation(result)`: writes result JSON + PNGs to a new directory under `~/.fleet/annotations/`, appends to index
- `getAnnotation(id)`: reads the result JSON from the annotation directory
- `listAnnotations()`: returns index entries
- `deleteAnnotation(id)`: removes directory and index entry
- `cleanup()`: deletes annotations older than `retentionDays`

### Integration with AnnotateService

Modify `AnnotateService.handleSubmit()` to write results to `~/.fleet/annotations/` instead of `os.tmpdir()`. The `writeResultFile` function gets an optional `outputDir` parameter. The CLI path also writes to `~/.fleet/annotations/` so CLI-created annotations appear in the UI too.

## Auto-Cleanup

- Runs once on app startup (not on a timer)
- Deletes annotation directories and index entries older than `retentionDays`
- `retentionDays` is configurable in Fleet settings

### Settings

Add to `FleetSettings`:

```typescript
annotate: {
  retentionDays: 3  // default
}
```

Exposed in the Settings tab UI as a simple number input: "Delete annotations older than N days".

## IPC Channels

New channels:

```typescript
ANNOTATE_UI_START: 'annotate:ui:start',       // renderer → main: trigger from UI
ANNOTATE_COMPLETED: 'annotate:completed',       // main → renderer: annotation done
ANNOTATE_LIST: 'annotate:list',                 // renderer → main: get annotation list
ANNOTATE_GET: 'annotate:get',                   // renderer → main: get annotation detail
ANNOTATE_DELETE: 'annotate:delete',             // renderer → main: delete annotation
```

## No Status Indicator

While the annotation browser is open, Fleet's main window shows no special status. The annotation browser is its own window; the user switches back to Fleet when done.
