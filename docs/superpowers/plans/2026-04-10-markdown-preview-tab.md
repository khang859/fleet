# Markdown Preview/Raw Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Preview/Raw sub-tab toggle for markdown files opened via `fleet open`, defaulting to rendered preview.

**Architecture:** New `'markdown'` pane type routes `.md` files to a `MarkdownPane` component that wraps both a `react-markdown` preview and the existing `FileEditorPane` editor. A sub-tab bar at the top toggles between views, with content synced from editor to preview on tab switch.

**Tech Stack:** react-markdown, remark-gfm (already installed), rehype-highlight (new), Tailwind CSS for styling.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/shared/types.ts` | Modify | Add `'markdown'` to `Tab.type` and `PaneLeaf.paneType` unions |
| `src/main/fleet-cli.ts` | Modify | Route `.md`/`.markdown` files to `paneType: 'markdown'` |
| `src/renderer/src/store/workspace-store.ts` | Modify | Map `'markdown'` paneType to `'markdown'` tab type in `openFileInTab` signature and body |
| `src/renderer/src/components/FileEditorPane.tsx` | Modify | Add optional `onContentChange` callback prop |
| `src/renderer/src/components/MarkdownPane.tsx` | Create | New component: sub-tab bar + preview + raw views |
| `src/renderer/src/components/PaneGrid.tsx` | Modify | Add `'markdown'` rendering branch |
| `package.json` | Modify | Add `rehype-highlight` dependency |

---

### Task 1: Install `rehype-highlight` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
npm install rehype-highlight
```

- [ ] **Step 2: Verify it installed**

Run: `npm ls rehype-highlight`
Expected: Shows `rehype-highlight@<version>` without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add rehype-highlight for markdown code block highlighting"
```

---

### Task 2: Add `'markdown'` to type unions

**Files:**
- Modify: `src/shared/types.ts:15` (Tab.type)
- Modify: `src/shared/types.ts:41` (PaneLeaf.paneType)

- [ ] **Step 1: Update `Tab.type` union**

In `src/shared/types.ts`, line 15, change:

```typescript
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi';
```

to:

```typescript
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown';
```

- [ ] **Step 2: Update `PaneLeaf.paneType` union**

In `src/shared/types.ts`, line 41, change:

```typescript
paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi';
```

to:

```typescript
paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown';
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — the new union member is additive and won't break any exhaustive checks (existing code uses `if` chains, not switch-exhaustive).

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add 'markdown' to Tab.type and PaneLeaf.paneType unions"
```

---

### Task 3: Route markdown files in CLI and store

**Files:**
- Modify: `src/main/fleet-cli.ts:7-16,553,574`
- Modify: `src/renderer/src/store/workspace-store.ts:155-157,856`

- [ ] **Step 1: Add `MARKDOWN_EXTENSIONS` set in `fleet-cli.ts`**

In `src/main/fleet-cli.ts`, after the `IMAGE_EXTENSIONS` set (after line 16), add:

```typescript
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
```

- [ ] **Step 2: Update the paneType in the `files` array type**

In `src/main/fleet-cli.ts`, line 553, change:

```typescript
const files: Array<{ path: string; paneType: 'file' | 'image' }> = [];
```

to:

```typescript
const files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown' }> = [];
```

- [ ] **Step 3: Update pane type detection**

In `src/main/fleet-cli.ts`, line 574, change:

```typescript
const paneType = IMAGE_EXTENSIONS.has(ext) ? ('image' as const) : ('file' as const);
```

to:

```typescript
const paneType = IMAGE_EXTENSIONS.has(ext)
  ? ('image' as const)
  : MARKDOWN_EXTENSIONS.has(ext)
    ? ('markdown' as const)
    : ('file' as const);
```

- [ ] **Step 4: Update `openFileInTab` type signature in workspace store**

In `src/renderer/src/store/workspace-store.ts`, lines 155-157, change:

```typescript
openFileInTab: (
  files: Array<{ path: string; paneType: 'file' | 'image'; label: string }>
) => void;
```

to:

```typescript
openFileInTab: (
  files: Array<{ path: string; paneType: 'file' | 'image' | 'markdown'; label: string }>
) => void;
```

- [ ] **Step 5: Update tab type mapping in `openFileInTab` body**

In `src/renderer/src/store/workspace-store.ts`, line 856, change:

```typescript
type: file.paneType === 'image' ? 'image' : 'file',
```

to:

```typescript
type: file.paneType === 'image' ? 'image' : file.paneType === 'markdown' ? 'markdown' : 'file',
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/fleet-cli.ts src/renderer/src/store/workspace-store.ts
git commit -m "feat: route markdown files to 'markdown' pane type in CLI and store"
```

---

### Task 4: Add `onContentChange` prop to `FileEditorPane`

**Files:**
- Modify: `src/renderer/src/components/FileEditorPane.tsx:95-100,196-207`

- [ ] **Step 1: Update the Props type**

In `src/renderer/src/components/FileEditorPane.tsx`, lines 95-98, change:

```typescript
type Props = {
  paneId: string;
  filePath: string;
};
```

to:

```typescript
type Props = {
  paneId: string;
  filePath: string;
  onContentChange?: (content: string) => void;
};
```

- [ ] **Step 2: Destructure the new prop**

In `src/renderer/src/components/FileEditorPane.tsx`, line 100, change:

```typescript
export function FileEditorPane({ paneId, filePath }: Props): React.JSX.Element {
```

to:

```typescript
export function FileEditorPane({ paneId, filePath, onContentChange }: Props): React.JSX.Element {
```

- [ ] **Step 3: Store callback in a ref for stable closure access**

After line 141 (`saveRef.current = save;`), add:

```typescript
const onContentChangeRef = useRef(onContentChange);
onContentChangeRef.current = onContentChange;
```

- [ ] **Step 4: Call the callback from the existing `updateListener`**

In the first `EditorView.updateListener.of(...)` block (lines 196-207), after the line `setIsDirty(dirty);` (line 200), add:

```typescript
onContentChangeRef.current?.(current);
```

So the block becomes:

```typescript
EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  const current = update.state.doc.toString();
  const dirty = current !== savedContentRef.current;
  setIsDirty(dirty);
  onContentChangeRef.current?.(current);
  setPaneDirty(paneId, dirty);
  if (dirty) {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      void saveRef.current();
    }, AUTO_SAVE_DELAY);
  }
}),
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — the prop is optional so existing callers are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/FileEditorPane.tsx
git commit -m "feat: add optional onContentChange callback to FileEditorPane"
```

---

### Task 5: Create `MarkdownPane` component

**Files:**
- Create: `src/renderer/src/components/MarkdownPane.tsx`

- [ ] **Step 1: Create the component file**

Create `src/renderer/src/components/MarkdownPane.tsx` with this content:

```tsx
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Components } from 'react-markdown';
import { FileEditorPane } from './FileEditorPane';
import { useWorkspaceStore } from '../store/workspace-store';
import { dirname, resolve } from '../lib/path-utils';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

type Props = {
  paneId: string;
  filePath: string;
};

type ViewMode = 'preview' | 'raw';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

function isMarkdownPath(href: string): boolean {
  const ext = href.split('.').pop()?.toLowerCase() ?? '';
  return MARKDOWN_EXTENSIONS.has(`.${ext}`);
}

function isExternalUrl(href: string): boolean {
  return /^https?:\/\//.test(href);
}

export function MarkdownPane({ paneId, filePath }: Props): React.JSX.Element {
  const [activeView, setActiveView] = useState<ViewMode>('preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [previewContent, setPreviewContent] = useState<string>('');
  const contentRef = useRef<string>('');
  const openFileInTab = useWorkspaceStore((s) => s.openFileInTab);

  // Load file content on mount
  useEffect(() => {
    void window.fleet.file.read(filePath).then((result) => {
      if (result.success && result.data) {
        if (result.data.size > MAX_FILE_SIZE) {
          setTooLarge(true);
          setFileSize(result.data.size);
        } else {
          contentRef.current = result.data.content;
          setPreviewContent(result.data.content);
        }
      } else {
        setError(('error' in result ? result.error : undefined) ?? 'Failed to read file');
      }
      setLoading(false);
    });
  }, [filePath]);

  // Sync content from editor to contentRef
  const handleContentChange = useCallback((content: string) => {
    contentRef.current = content;
  }, []);

  // Refresh preview content when switching to preview tab
  const handleTabSwitch = useCallback(
    (view: ViewMode) => {
      if (view === 'preview') {
        setPreviewContent(contentRef.current);
      }
      setActiveView(view);
    },
    []
  );

  // Custom link renderer for Fleet-aware navigation
  const baseDir = useMemo(() => dirname(filePath), [filePath]);

  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children, ...props }) => {
        if (!href) return <span {...props}>{children}</span>;

        // Anchor links — scroll within preview
        if (href.startsWith('#')) {
          return (
            <a
              href={href}
              className="text-blue-400 hover:underline cursor-pointer"
              onClick={(e) => {
                e.preventDefault();
                const target = document.getElementById(href.slice(1));
                target?.scrollIntoView({ behavior: 'smooth' });
              }}
              {...props}
            >
              {children}
            </a>
          );
        }

        // External URLs — open in system browser
        if (isExternalUrl(href)) {
          return (
            <a
              href={href}
              className="text-blue-400 hover:underline cursor-pointer"
              onClick={(e) => {
                e.preventDefault();
                window.open(href);
              }}
              {...props}
            >
              {children}
            </a>
          );
        }

        // Relative links — open in Fleet
        const resolvedPath = resolve(baseDir, href);
        const paneType = isMarkdownPath(href) ? 'markdown' : 'file';
        const label = href.split('/').pop() ?? href;

        return (
          <a
            href={href}
            className="text-blue-400 hover:underline cursor-pointer"
            onClick={(e) => {
              e.preventDefault();
              openFileInTab([{ path: resolvedPath, paneType, label }]);
            }}
            {...props}
          >
            {children}
          </a>
        );
      }
    }),
    [baseDir, openFileInTab]
  );

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#282c34] text-neutral-400 text-sm">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#282c34] text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  if (tooLarge) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#282c34] text-neutral-400 text-sm gap-2">
        <div className="text-3xl text-neutral-500">⚠</div>
        <div className="font-medium text-neutral-200">File too large to preview</div>
        <div className="text-neutral-500">
          {(fileSize / 1024 / 1024).toFixed(1)} MB — limit is 10 MB
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden bg-[#282c34]">
      {/* Sub-tab bar */}
      <div className="flex-shrink-0 flex items-center gap-0 border-b border-neutral-800 bg-neutral-950/60 px-2">
        <button
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
            activeView === 'preview'
              ? 'border-teal-400 text-neutral-100'
              : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
          onClick={() => handleTabSwitch('preview')}
        >
          Preview
        </button>
        <button
          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
            activeView === 'raw'
              ? 'border-teal-400 text-neutral-100'
              : 'border-transparent text-neutral-500 hover:text-neutral-300'
          }`}
          onClick={() => handleTabSwitch('raw')}
        >
          Raw
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeView === 'preview' ? (
          <div className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-8 py-6 text-neutral-300 leading-relaxed markdown-preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={markdownComponents}
              >
                {previewContent}
              </ReactMarkdown>
            </div>
          </div>
        ) : (
          <FileEditorPane
            paneId={paneId}
            filePath={filePath}
            onContentChange={handleContentChange}
          />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create path utility helpers**

Check if `src/renderer/src/lib/path-utils.ts` exists. If not, create it:

```typescript
/**
 * Minimal path utilities for the renderer process.
 * Node's `path` module is not available in the browser context.
 */

export function dirname(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash === -1 ? '.' : filePath.slice(0, lastSlash);
}

export function resolve(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative;
  const parts = `${base}/${relative}`.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return '/' + resolved.join('/');
}
```

If the file already exists with a similar `dirname`/`resolve`, reuse it and skip this step.

- [ ] **Step 3: Add markdown preview CSS styles**

Add these styles to the app's main CSS file (likely `src/renderer/src/assets/main.css` or similar global CSS). Append:

```css
/* ── Markdown Preview Prose Styles ──────────────────────────────────── */

.markdown-preview h1 { font-size: 1.5rem; font-weight: 700; color: rgb(245 245 245); margin-top: 1.5rem; margin-bottom: 0.75rem; }
.markdown-preview h2 { font-size: 1.25rem; font-weight: 600; color: rgb(245 245 245); margin-top: 1.25rem; margin-bottom: 0.5rem; }
.markdown-preview h3 { font-size: 1.125rem; font-weight: 600; color: rgb(245 245 245); margin-top: 1rem; margin-bottom: 0.5rem; }
.markdown-preview h4,
.markdown-preview h5,
.markdown-preview h6 { font-size: 1rem; font-weight: 600; color: rgb(229 229 229); margin-top: 0.75rem; margin-bottom: 0.5rem; }

.markdown-preview p { margin-bottom: 0.75rem; }

.markdown-preview a { color: rgb(96 165 250); cursor: pointer; }
.markdown-preview a:hover { text-decoration: underline; }

.markdown-preview code:not(pre code) {
  background: rgb(38 38 38);
  padding: 0.125rem 0.375rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  font-family: 'JetBrains Mono Nerd Font', monospace;
}

.markdown-preview pre {
  background: rgb(23 23 23);
  border-radius: 0.375rem;
  padding: 1rem;
  overflow-x: auto;
  margin-bottom: 0.75rem;
  font-size: 0.875rem;
  font-family: 'JetBrains Mono Nerd Font', monospace;
}

.markdown-preview blockquote {
  border-left: 2px solid rgb(82 82 82);
  padding-left: 1rem;
  color: rgb(163 163 163);
  margin-bottom: 0.75rem;
}

.markdown-preview ul { list-style-type: disc; padding-left: 1.5rem; margin-bottom: 0.75rem; }
.markdown-preview ol { list-style-type: decimal; padding-left: 1.5rem; margin-bottom: 0.75rem; }
.markdown-preview li { margin-bottom: 0.25rem; }

.markdown-preview table { border-collapse: collapse; width: 100%; margin-bottom: 0.75rem; }
.markdown-preview th { border: 1px solid rgb(64 64 64); padding: 0.5rem; text-align: left; font-weight: 600; color: rgb(229 229 229); background: rgb(38 38 38); }
.markdown-preview td { border: 1px solid rgb(64 64 64); padding: 0.5rem; }
.markdown-preview tr:nth-child(even) { background: rgba(38, 38, 38, 0.5); }

.markdown-preview hr { border: none; border-top: 1px solid rgb(64 64 64); margin: 1.5rem 0; }

.markdown-preview img { max-width: 100%; border-radius: 0.375rem; margin-bottom: 0.75rem; }
```

- [ ] **Step 4: Import highlight.js dark theme CSS**

`rehype-highlight` requires a highlight.js CSS theme. In the same global CSS file, add at the top:

```css
@import 'highlight.js/styles/atom-one-dark.css';
```

Or if the build system doesn't support bare specifier imports in CSS, add the import in the component file (`MarkdownPane.tsx`) at the top:

```typescript
import 'highlight.js/styles/atom-one-dark.css';
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/MarkdownPane.tsx src/renderer/src/lib/path-utils.ts src/renderer/src/assets/main.css
git commit -m "feat: create MarkdownPane with preview/raw sub-tabs"
```

---

### Task 6: Wire `MarkdownPane` into `PaneGrid`

**Files:**
- Modify: `src/renderer/src/components/PaneGrid.tsx:1-6,149-156`

- [ ] **Step 1: Add import**

In `src/renderer/src/components/PaneGrid.tsx`, after line 5 (`import { FileEditorPane } from './FileEditorPane';`), add:

```typescript
import { MarkdownPane } from './MarkdownPane';
```

- [ ] **Step 2: Add markdown rendering branch**

In `src/renderer/src/components/PaneGrid.tsx`, after the `file` pane block (after line 155, the closing `}`), add:

```typescript
if (leaf.node.paneType === 'markdown') {
  return (
    <div key={leaf.id} style={rectStyle(leaf.rect)}>
      <MarkdownPane paneId={leaf.id} filePath={leaf.node.filePath ?? ''} />
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: PASS — full build including electron-vite bundling.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/PaneGrid.tsx
git commit -m "feat: wire MarkdownPane into PaneGrid for markdown pane type"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Start the app in dev mode**

Run: `npm run dev`

- [ ] **Step 2: Test opening a markdown file**

In a terminal (not inside Fleet), run:

```bash
fleet open README.md
```

Expected: A new tab opens with the Preview view active, showing the rendered README with styled headings, lists, code blocks, and links.

- [ ] **Step 3: Test sub-tab switching**

Click the "Raw" tab. Expected: CodeMirror editor appears with the markdown source.
Click the "Preview" tab. Expected: Rendered preview returns.

- [ ] **Step 4: Test edit-then-preview sync**

1. Click "Raw" tab
2. Make an edit (e.g., add `## Test Heading` at the top)
3. Click "Preview" tab
4. Expected: The preview shows the new heading. Auto-save should have persisted the change after 3 seconds.

- [ ] **Step 5: Test link handling**

1. Open a markdown file that contains:
   - A relative `.md` link (e.g., `[link](./other.md)`) — should open as a new markdown tab
   - An external URL (e.g., `[GitHub](https://github.com)`) — should open in system browser
2. Verify both behaviors work correctly.

- [ ] **Step 6: Test file deduplication**

Run `fleet open README.md` again while it's already open. Expected: focuses the existing tab instead of creating a duplicate.
