# Terminal File Drag-and-Drop Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable dragging files from the OS file manager into Fleet's terminal panes, inserting the quoted file path as PTY text input.

**Architecture:** React drag event handlers on the existing `TerminalPane` wrapper div write formatted file paths to the PTY via `window.fleet.pty.input()`. Path resolution uses Electron's `webUtils.getPathForFile()` exposed through the preload bridge. A visual overlay provides drop zone feedback.

**Tech Stack:** Electron 39, React, TypeScript, xterm.js 5.5, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-16-terminal-file-drop-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/preload/index.ts` | Modify | Add `utils.getFilePath` and `platform` to the preload API |
| `src/renderer/src/components/TerminalPane.tsx` | Modify | Drag event handlers, overlay UI, path formatting, PTY write |

The `FleetApi` type in `src/preload/index.ts` is auto-derived via `typeof fleetApi`, and `src/renderer/src/env.d.ts` imports it — so types update automatically. No type file changes needed.

---

## Task 1: Expose `webUtils.getFilePath` and `platform` in preload

**Files:**
- Modify: `src/preload/index.ts:1-2` (imports), `src/preload/index.ts:74` (after `homeDir`)

- [ ] **Step 1: Add `webUtils` import**

In `src/preload/index.ts`, change line 1 from:
```typescript
import { contextBridge, ipcRenderer } from 'electron';
```
to:
```typescript
import { contextBridge, ipcRenderer, webUtils } from 'electron';
```

- [ ] **Step 2: Add `utils` namespace and `platform` to `fleetApi`**

After the `homeDir: homedir(),` line (line 74), add:

```typescript
  platform: process.platform,
  utils: {
    getFilePath: (file: File): string => webUtils.getPathForFile(file),
  },
```

- [ ] **Step 3: Verify typecheck passes**

Run: `npx electron-vite build 2>&1 | head -30`
Expected: Build succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat: expose webUtils.getFilePath and platform in preload API"
```

---

## Task 2: Add drag-and-drop event handlers and overlay to TerminalPane

**Files:**
- Modify: `src/renderer/src/components/TerminalPane.tsx`

- [ ] **Step 1: Add drag state and ref**

At the top of the `TerminalPane` component (after the existing `useState` calls around line 23), add:

```typescript
const [isDragOver, setIsDragOver] = useState(false);
const dragCounterRef = useRef(0);
```

- [ ] **Step 2: Add path formatting helper**

Above the `TerminalPane` component function (after imports, before the type definition), add:

```typescript
function quotePathForShell(filePath: string, platform: string): string {
  if (platform === 'win32') {
    return '"' + filePath.replace(/"/g, '\\"') + '"';
  }
  // POSIX: single-quote, escape internal single quotes as '\''
  return "'" + filePath.replace(/'/g, "'\\''" ) + "'";
}

function formatDroppedFiles(files: FileList, platform: string): string {
  const paths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const filePath = window.fleet.utils.getFilePath(files[i]);
    paths.push(quotePathForShell(filePath, platform));
  }
  return paths.join(' ') + ' ';
}
```

- [ ] **Step 3: Add drag event handlers**

Inside the `TerminalPane` component, after the `useEffect` for search toggle (after line 35), add:

```typescript
const handleDragOver = (e: React.DragEvent) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
};

const handleDragEnter = (e: React.DragEvent) => {
  e.preventDefault();
  // Only show overlay for file drags, not text/URL drags
  if (!e.dataTransfer.types.includes('Files')) return;
  dragCounterRef.current++;
  if (dragCounterRef.current === 1) {
    setIsDragOver(true);
  }
};

const handleDragLeave = () => {
  dragCounterRef.current--;
  if (dragCounterRef.current === 0) {
    setIsDragOver(false);
  }
};

const handleDrop = (e: React.DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  dragCounterRef.current = 0;
  setIsDragOver(false);

  if (e.dataTransfer.files.length > 0) {
    const formatted = formatDroppedFiles(e.dataTransfer.files, window.fleet.platform);
    window.fleet.pty.input({ paneId, data: formatted });
    focus();
  }
};
```

- [ ] **Step 4: Add document-level safety net**

Add a `useEffect` after the handlers to reset drag state if the overlay gets stuck (e.g., user drops outside the pane or cancels with Escape):

```typescript
useEffect(() => {
  const resetDrag = () => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
  };
  document.addEventListener('drop', resetDrag);
  document.addEventListener('dragend', resetDrag);
  return () => {
    document.removeEventListener('drop', resetDrag);
    document.removeEventListener('dragend', resetDrag);
  };
}, []);
```

- [ ] **Step 5: Attach handlers to the wrapper div**

On the outer `<div>` in the JSX (line 38), add the four drag handlers:

```tsx
<div
  className={`relative h-full w-full overflow-hidden p-3 transition-[box-shadow] duration-0 ${isActive ? 'ring-2 ring-blue-500/70 bg-[#151515]' : 'ring-1 ring-neutral-800/50 bg-[#131313]'}`}
  onMouseEnter={() => setHovered(true)}
  onMouseLeave={() => setHovered(false)}
  onFocus={onFocus}
  onClick={() => {
    onFocus();
    focus();
    fit();
  }}
  onDragOver={handleDragOver}
  onDragEnter={handleDragEnter}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
>
```

- [ ] **Step 6: Add the visual overlay**

Inside the wrapper div, just before the closing `</div>` (before line 67), add the overlay:

```tsx
{isDragOver && (
  <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-400 rounded pointer-events-none">
    <span className="text-blue-300 text-sm font-medium">Drop to paste file path</span>
  </div>
)}
```

- [ ] **Step 7: Verify typecheck passes**

Run: `npx electron-vite build 2>&1 | head -30`
Expected: Build succeeds with no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/TerminalPane.tsx
git commit -m "feat: add file drag-and-drop to terminal panes"
```

---

## Task 3: Manual verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Test single file drop**

Drag a single file from Finder into a terminal pane.
Expected: The file path appears as quoted text in the terminal input, followed by a trailing space.

- [ ] **Step 3: Test multiple file drop**

Select multiple files in Finder and drag them into a terminal pane.
Expected: Multiple space-separated quoted paths appear in the terminal input.

- [ ] **Step 4: Test path with spaces**

Drag a file whose path contains spaces.
Expected: Path is properly quoted (e.g. `'/Users/me/My Documents/file.txt' `).

- [ ] **Step 5: Test visual overlay**

Drag a file over a terminal pane without dropping.
Expected: Blue dashed overlay appears with "Drop to paste file path" text. Overlay disappears when dragging away.

- [ ] **Step 6: Test non-file drag**

Drag selected text from another app over the terminal.
Expected: No overlay appears, no text is inserted on drop.

- [ ] **Step 7: Test split panes**

With split panes active, drag a file into one pane.
Expected: Only the targeted pane shows the overlay, path is written to the correct PTY.

- [ ] **Step 8: Test with Claude Code**

Start Claude Code in a terminal pane. Drag a file in.
Expected: The file path appears at the CLI prompt, ready to submit.
