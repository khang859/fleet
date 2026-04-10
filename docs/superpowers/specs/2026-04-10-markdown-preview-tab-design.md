# Markdown Preview/Raw Tab Design

**Date:** 2026-04-10
**Status:** Approved

## Summary

When opening a markdown file with `fleet open`, display it in a new `MarkdownPane` component that defaults to a rendered preview view. A sub-tab bar at the top of the pane lets the user switch between **Preview** (rendered markdown) and **Raw** (full CodeMirror editor). This follows Baymard's readability guidelines and NNG's visibility-of-system-status heuristic.

## Requirements

- Default view: Preview (rendered markdown)
- Raw view: full editable CodeMirror editor (reuses existing `FileEditorPane`)
- Sub-tab bar at the top of the pane (GitHub-style: `[Preview] [Raw]`)
- Preview re-renders on tab switch (not live-syncing)
- Syntax-highlighted fenced code blocks in preview via `rehype-highlight`
- Link handling:
  - Relative `.md` links open as new Fleet markdown tabs
  - Relative non-markdown links open as new Fleet file tabs
  - External URLs open in system browser
  - Anchor links scroll within the preview

## Data Model Changes

### `src/shared/types.ts`

Add `'markdown'` to both type unions:

```typescript
// Tab.type
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown';

// PaneLeaf.paneType
paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown';
```

No new fields needed — `filePath` already exists on `PaneLeaf`.

## File-Open Routing

### `src/main/fleet-cli.ts` (~line 568-574)

Add markdown detection alongside image detection:

```typescript
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

// In the open command handler:
const ext = extname(resolved).toLowerCase();
const paneType = IMAGE_EXTENSIONS.has(ext) ? 'image'
  : MARKDOWN_EXTENSIONS.has(ext) ? 'markdown'
  : 'file';
```

### `src/main/socket-server.ts`

No changes needed — already forwards `paneType` from CLI payload.

### `src/renderer/src/store/workspace-store.ts` (~line 856)

Update tab type mapping:

```typescript
type: file.paneType === 'image' ? 'image'
  : file.paneType === 'markdown' ? 'markdown'
  : 'file',
```

### `src/renderer/src/components/PaneGrid.tsx` (~line 149)

Add rendering branch:

```typescript
if (leaf.node.paneType === 'markdown') {
  return <MarkdownPane paneId={leaf.id} filePath={leaf.node.filePath ?? ''} />;
}
```

## MarkdownPane Component

**New file:** `src/renderer/src/components/MarkdownPane.tsx`

### Props

```typescript
type Props = {
  paneId: string;
  filePath: string;
};
```

### State

- `activeView`: `'preview' | 'raw'` — defaults to `'preview'`
- `content`: `string | null` — file content loaded on mount
- `loading` / `error` / `tooLarge` — same pattern as `FileEditorPane`

### Layout

```
┌─────────────────────────────────┐
│  [Preview]  [Raw]               │  ← sub-tab bar
├─────────────────────────────────┤
│                                 │
│   (content area)                │  ← swapped based on activeView
│                                 │
├─────────────────────────────────┤
│  status bar (Raw only)          │  ← Markdown / Saved / Ln, Col
└─────────────────────────────────┘
```

### Sub-Tab Bar

- Two text buttons, left-aligned
- Active tab: bottom border accent (teal/blue), brighter text (`text-neutral-100`)
- Inactive tab: muted text (`text-neutral-500`), hover brightens
- Styled with Tailwind only — no new component library
- Follows NNG's visibility of system status: always clear which view is active

### Preview View

- Rendered with `react-markdown` + `remark-gfm` (both already installed)
- Syntax-highlighted code blocks via `rehype-highlight` (new dependency)
- Scrollable container with reading-optimized layout

### Raw View

- Embeds the existing `FileEditorPane` component directly
- Full CodeMirror editing with auto-save, dirty state, cursor position
- No duplication of editor logic

### Tab Switch Behavior

When switching from Raw to Preview: `MarkdownPane` holds a `contentRef` that `FileEditorPane` updates via an `onContentChange` callback prop (debounced or on-blur). On tab switch, Preview renders from `contentRef.current`. This avoids re-reading the file from disk and ensures unsaved edits are visible in Preview. Refresh-on-switch, not live-sync — the preview only re-renders when the user clicks the Preview tab.

### Link Handling

Custom `react-markdown` link renderer:
- Relative `.md`/`.markdown` links → `openFileInTab({ path: resolved, paneType: 'markdown' })`
- Relative non-markdown links → `openFileInTab({ path: resolved, paneType: 'file' })`
- External URLs (`http://`, `https://`) → `window.open(url)`
- Anchor links (`#heading`) → scroll within preview container

Path resolution uses the directory of the current file as the base.

## Preview Styling

### Typography (Baymard line-length guidelines)

- Max content width: `max-w-3xl` (~48rem / ~72 characters) centered in pane
- Generous horizontal padding for comfortable reading
- `leading-relaxed` line height

### Element Styles (Dark Theme)

| Element | Style |
|---------|-------|
| Headings | `text-neutral-100`, scaled sizes (h1 `text-2xl`, h2 `text-xl`, etc.) |
| Body text | `text-neutral-300`, `leading-relaxed` |
| Links | `text-blue-400 hover:underline`, cursor pointer |
| Inline code | `bg-neutral-800 px-1.5 py-0.5 rounded text-sm font-mono` |
| Blockquotes | `border-l-2 border-neutral-600 pl-4 text-neutral-400` |
| Tables | `border-neutral-700`, alternating row backgrounds |
| Lists | Proper indentation and bullet/number styling |
| Horizontal rules | `border-neutral-700` |

### Code Blocks

- `rehype-highlight` with hljs one-dark theme variant (matches existing CodeMirror one-dark)
- Monospace font, `bg-neutral-900` background, rounded corners, padding

## New Dependencies

- `rehype-highlight` — syntax highlighting for fenced code blocks in preview

## Files Changed

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `'markdown'` to `Tab.type` and `PaneLeaf.paneType` unions |
| `src/main/fleet-cli.ts` | Add `MARKDOWN_EXTENSIONS` set, route `.md` files to `paneType: 'markdown'` |
| `src/renderer/src/store/workspace-store.ts` | Map `'markdown'` paneType to `'markdown'` tab type |
| `src/renderer/src/components/PaneGrid.tsx` | Add `'markdown'` branch rendering `MarkdownPane` |
| `src/renderer/src/components/FileEditorPane.tsx` | Add optional `onContentChange?: (content: string) => void` prop, called from the existing `EditorView.updateListener` on doc changes |
| `src/renderer/src/components/MarkdownPane.tsx` | **New file** — MarkdownPane component |
| `package.json` | Add `rehype-highlight` dependency |
