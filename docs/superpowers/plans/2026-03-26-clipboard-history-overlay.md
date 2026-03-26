# Clipboard History Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Clipboard History overlay (Cmd+Shift+H) that shows the current clipboard content plus the 5 most recent entries, with preview on hover and click-to-paste into the active terminal pane.

**Architecture:** A main-process clipboard monitor polls the system clipboard every 500ms, detects changes by comparing against the last known text value, and pushes updates to the renderer via IPC. The renderer maintains an in-memory history (session-only, max 20 entries) and displays them in a new `ClipboardHistoryOverlay` component that follows the same overlay pattern as `FileSearchOverlay` and `QuickOpenOverlay`. Primary action pastes into the active terminal via bracketed paste.

**Tech Stack:** Electron `clipboard` API (main process), IPC channels, React, Tailwind, xterm.js bracketed paste

**References:**
- Issue: https://github.com/khang859/fleet/issues/157
- Existing overlay pattern: `src/renderer/src/components/FileSearchOverlay.tsx`
- Shell utils (bracketedPaste): `src/renderer/src/lib/shell-utils.ts`
- Shortcut system: `src/renderer/src/lib/shortcuts.ts`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `src/main/clipboard-monitor.ts` | Main-process clipboard polling, change detection, history storage |
| Create | `src/renderer/src/components/ClipboardHistoryOverlay.tsx` | Overlay UI: list, preview, keyboard nav, paste action |
| Modify | `src/shared/ipc-channels.ts` | Add `CLIPBOARD_HISTORY` and `CLIPBOARD_CHANGED` channels |
| Modify | `src/shared/ipc-api.ts` | Add `ClipboardEntry` and `ClipboardHistoryResponse` types |
| Modify | `src/main/ipc-handlers.ts` | Register clipboard IPC handlers, start/stop monitor |
| Modify | `src/preload/index.ts` | Expose clipboard bridge to renderer |
| Modify | `src/renderer/src/lib/shortcuts.ts` | Add `clipboard-history` shortcut (Cmd+Shift+H) |
| Modify | `src/renderer/src/lib/commands.ts` | Add command palette entry |
| Modify | `src/renderer/src/hooks/use-pane-navigation.ts` | Add keyboard handler for new shortcut |
| Modify | `src/renderer/src/App.tsx` | Mount overlay, event listener, subscribe to clipboard changes |

---

### Task 1: IPC Types and Channels

**Files:**
- Modify: `src/shared/ipc-api.ts:355-357` (append after `RecentImagesResponse`)
- Modify: `src/shared/ipc-channels.ts:73` (append after `FILE_RECENT_IMAGES`)

- [ ] **Step 1: Add clipboard types to `ipc-api.ts`**

Add these types at the end of the file, after `RecentImagesResponse`:

```typescript
export type ClipboardEntry = {
  id: number;
  text: string;
  timestamp: number;
  charCount: number;
  lineCount: number;
  preview: string; // first 200 chars, truncated
};

export type ClipboardHistoryResponse = {
  entries: ClipboardEntry[];
};
```

- [ ] **Step 2: Add IPC channels to `ipc-channels.ts`**

Add two new channels after `FILE_RECENT_IMAGES`:

```typescript
CLIPBOARD_HISTORY: 'clipboard:history',
CLIPBOARD_CHANGED: 'clipboard:changed'
```

`CLIPBOARD_HISTORY` is a request/response channel (renderer asks for current history).
`CLIPBOARD_CHANGED` is a push channel (main process notifies renderer of new entries).

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-api.ts src/shared/ipc-channels.ts
git commit -m "feat(clipboard): add IPC types and channels for clipboard history"
```

---

### Task 2: Clipboard Monitor (Main Process)

**Files:**
- Create: `src/main/clipboard-monitor.ts`

- [ ] **Step 1: Create the clipboard monitor module**

```typescript
import { clipboard, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type { ClipboardEntry } from '../shared/ipc-api';

const MAX_HISTORY = 20;
const POLL_INTERVAL_MS = 500;
const PREVIEW_LENGTH = 200;

let history: ClipboardEntry[] = [];
let lastText = '';
let nextId = 1;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function makeEntry(text: string): ClipboardEntry {
  const lines = text.split('\n');
  return {
    id: nextId++,
    text,
    timestamp: Date.now(),
    charCount: text.length,
    lineCount: lines.length,
    preview: text.length > PREVIEW_LENGTH ? text.slice(0, PREVIEW_LENGTH) + '...' : text
  };
}

function poll(): void {
  const text = clipboard.readText().trim();
  if (!text || text === lastText) return;

  lastText = text;

  // Deduplicate: remove any existing entry with the same text
  history = history.filter((e) => e.text !== text);
  history.unshift(makeEntry(text));
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  // Push to all renderer windows
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.CLIPBOARD_CHANGED, { entries: history });
    }
  }
}

export function startClipboardMonitor(): void {
  if (pollTimer) return;
  // Seed with current clipboard content
  const initial = clipboard.readText().trim();
  if (initial) {
    lastText = initial;
    history.unshift(makeEntry(initial));
  }
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

export function stopClipboardMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export function getClipboardHistory(): ClipboardEntry[] {
  return history;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main/clipboard-monitor.ts
git commit -m "feat(clipboard): add main-process clipboard monitor with 500ms polling"
```

---

### Task 3: IPC Handlers

**Files:**
- Modify: `src/main/ipc-handlers.ts:602-607` (append after file search handlers)

- [ ] **Step 1: Import and register clipboard handlers**

Add the import at the top of `ipc-handlers.ts`:

```typescript
import { startClipboardMonitor, getClipboardHistory } from './clipboard-monitor';
```

Add the handler registration at the end of the `registerIpcHandlers` function, after the `FILE_RECENT_IMAGES` handler:

```typescript
  // Clipboard history
  ipcMain.handle(IPC_CHANNELS.CLIPBOARD_HISTORY, () => ({
    entries: getClipboardHistory()
  }));

  startClipboardMonitor();
```

- [ ] **Step 2: Commit**

```bash
git add src/main/ipc-handlers.ts
git commit -m "feat(clipboard): register IPC handler and start clipboard monitor"
```

---

### Task 4: Preload Bridge

**Files:**
- Modify: `src/preload/index.ts:314` (add after `searchRecentImages`)

- [ ] **Step 1: Add clipboard namespace to the preload bridge**

Add a new `clipboard` namespace to the `fleetApi` object, after the `file` namespace:

```typescript
clipboard: {
  getHistory: async (): Promise<ClipboardHistoryResponse> =>
    typedInvoke(IPC_CHANNELS.CLIPBOARD_HISTORY),
  onChanged: (callback: (payload: ClipboardHistoryResponse) => void): Unsubscribe =>
    onChannel(IPC_CHANNELS.CLIPBOARD_CHANGED, callback)
},
```

Add the import for `ClipboardHistoryResponse` to the existing import from `'../shared/ipc-api'`.

- [ ] **Step 2: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(clipboard): expose clipboard bridge to renderer"
```

---

### Task 5: Keyboard Shortcut and Command Palette

**Files:**
- Modify: `src/renderer/src/lib/shortcuts.ts:127` (append after `file-search`)
- Modify: `src/renderer/src/lib/commands.ts:123` (append after `file-search` command)
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts:132` (append after `file-search` handler)

- [ ] **Step 1: Add shortcut definition**

Note: `Cmd+Shift+V` is already taken by the `visualizer` shortcut. Use `Cmd+Shift+H` instead (matches iTerm2's clipboard history shortcut).

Add to the end of `ALL_SHORTCUTS` in `shortcuts.ts`:

```typescript
{
  id: 'clipboard-history',
  label: 'Clipboard history',
  mac: { key: 'H', meta: true, shift: true },
  other: { key: 'H', ctrl: true, shift: true }
}
```

- [ ] **Step 2: Add command palette entry**

Add to the end of the array returned by `createCommandRegistry()` in `commands.ts`:

```typescript
{
  id: 'clipboard-history',
  label: 'Clipboard History',
  shortcut: sc('clipboard-history'),
  category: 'Edit',
  execute: () => document.dispatchEvent(new CustomEvent('fleet:toggle-clipboard-history'))
}
```

- [ ] **Step 3: Add keyboard handler in `use-pane-navigation.ts`**

Add after the `file-search` handler block (after line 132):

```typescript
if (matchesShortcut(e, sc('clipboard-history'))) {
  e.preventDefault();
  document.dispatchEvent(new CustomEvent('fleet:toggle-clipboard-history'));
  return;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/shortcuts.ts src/renderer/src/lib/commands.ts src/renderer/src/hooks/use-pane-navigation.ts
git commit -m "feat(clipboard): add Cmd+Shift+H shortcut and command palette entry"
```

---

### Task 6: Clipboard History Overlay Component

**Files:**
- Create: `src/renderer/src/components/ClipboardHistoryOverlay.tsx`

- [ ] **Step 1: Create the overlay component**

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { Clipboard, X } from 'lucide-react';
import { useWorkspaceStore } from '../store/workspace-store';
import { bracketedPaste } from '../lib/shell-utils';
import type { ClipboardEntry } from '../../../shared/ipc-api';

type ClipboardHistoryOverlayProps = {
  isOpen: boolean;
  onClose: () => void;
};

function formatTimestamp(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(epochMs).toLocaleTimeString();
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + '\n...';
}

export function ClipboardHistoryOverlay({
  isOpen,
  onClose
}: ClipboardHistoryOverlayProps): React.JSX.Element | null {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const activePaneId = useWorkspaceStore((s) => s.activePaneId);

  // Load history and subscribe to changes
  useEffect(() => {
    if (!isOpen) return;

    setFilter('');
    setSelectedIndex(0);

    // Fetch current history
    void window.fleet.clipboard.getHistory().then((res) => {
      setEntries(res.entries);
    });

    // Subscribe to live updates
    const unsub = window.fleet.clipboard.onChanged((payload) => {
      setEntries(payload.entries);
    });

    requestAnimationFrame(() => inputRef.current?.focus());

    return unsub;
  }, [isOpen]);

  // Reset selection when entries or filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [entries, filter]);

  // Scroll selected into view
  useEffect(() => {
    const child = listRef.current?.children[selectedIndex];
    if (child instanceof HTMLElement) child.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const filtered = filter
    ? entries.filter((e) => e.text.toLowerCase().includes(filter.toLowerCase()))
    : entries;

  const handlePaste = useCallback(
    (entry: ClipboardEntry) => {
      if (!activePaneId) return;
      window.fleet.pty.input({ paneId: activePaneId, data: bracketedPaste(entry.text) });
      onClose();
    },
    [activePaneId, onClose]
  );

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const entry = filtered[selectedIndex];
      if (entry) handlePaste(entry);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60" onClick={onClose}>
      <div
        className="mt-[15vh] w-[560px] max-h-[60vh] flex flex-col bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-3 py-2 border-b border-neutral-800 flex items-center gap-2">
          <Clipboard size={14} className="text-neutral-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Filter clipboard history..."
            className="flex-1 bg-transparent text-sm text-white outline-none placeholder-neutral-500"
          />
          <span className="text-[10px] text-neutral-600">{filtered.length} items</span>
        </div>

        {/* Entries list */}
        <div ref={listRef} className="overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-sm text-neutral-500 text-center">
              {entries.length === 0 ? 'Clipboard history is empty' : 'No matching entries'}
            </div>
          ) : (
            filtered.map((entry, i) => (
              <button
                key={entry.id}
                className={`w-full flex flex-col gap-0.5 px-3 py-2 text-left transition-colors ${
                  i === selectedIndex
                    ? 'bg-neutral-700 text-white'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
                onMouseEnter={() => setSelectedIndex(i)}
                onClick={() => handlePaste(entry)}
              >
                <pre className="text-sm font-mono whitespace-pre-wrap break-all line-clamp-3">
                  {truncateLines(entry.preview, 3)}
                </pre>
                <div className="flex items-center gap-2 text-[10px] text-neutral-600">
                  <span>{formatTimestamp(entry.timestamp)}</span>
                  <span>{entry.charCount} chars</span>
                  {entry.lineCount > 1 && <span>{entry.lineCount} lines</span>}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Preview pane for selected entry */}
        {filtered[selectedIndex] && filtered[selectedIndex].text.length > 200 && (
          <div className="border-t border-neutral-800 px-3 py-2 max-h-[20vh] overflow-y-auto">
            <div className="text-[10px] text-neutral-600 uppercase tracking-wider mb-1">
              Preview
            </div>
            <pre className="text-xs font-mono text-neutral-400 whitespace-pre-wrap break-all">
              {filtered[selectedIndex].text}
            </pre>
          </div>
        )}

        {/* Footer */}
        <div className="px-3 py-1.5 border-t border-neutral-800 flex items-center gap-3 text-xs text-neutral-600">
          {!activePaneId ? (
            <span className="text-amber-500/80">No active terminal</span>
          ) : (
            <>
              <span>↑↓ navigate</span>
              <span>↵ paste to terminal</span>
              <span>esc dismiss</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/src/components/ClipboardHistoryOverlay.tsx
git commit -m "feat(clipboard): add ClipboardHistoryOverlay component"
```

---

### Task 7: Mount Overlay in App.tsx

**Files:**
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add import**

Add this import alongside the other overlay imports (near line 22):

```typescript
import { ClipboardHistoryOverlay } from './components/ClipboardHistoryOverlay';
```

- [ ] **Step 2: Add state**

Add this state declaration alongside the other overlay states (near line 98):

```typescript
const [clipboardHistoryOpen, setClipboardHistoryOpen] = useState(false);
```

- [ ] **Step 3: Add event listener**

Add this useEffect block after the `fleet:toggle-file-search` listener (after line 152):

```typescript
// Clipboard history overlay toggle (Cmd+Shift+H)
useEffect(() => {
  const handler = (): void => setClipboardHistoryOpen((prev) => !prev);
  document.addEventListener('fleet:toggle-clipboard-history', handler);
  return () => document.removeEventListener('fleet:toggle-clipboard-history', handler);
}, []);
```

- [ ] **Step 4: Mount the component**

Add the component in the JSX, alongside the other overlay components (near where `FileSearchOverlay` is rendered):

```tsx
<ClipboardHistoryOverlay
  isOpen={clipboardHistoryOpen}
  onClose={() => setClipboardHistoryOpen(false)}
/>
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(clipboard): mount ClipboardHistoryOverlay in App"
```

---

### Task 8: Type Check and Smoke Test

**Files:** None (verification only)

- [ ] **Step 1: Run type checker**

```bash
npm run typecheck
```

Expected: No errors. If there are type errors, fix them before proceeding.

- [ ] **Step 2: Run lint**

```bash
npm run lint
```

Expected: No errors.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: Build succeeds.

- [ ] **Step 4: Manual smoke test**

1. Launch the app (`npm run dev`)
2. Press `Cmd+Shift+H` (macOS) or `Ctrl+Shift+H` (Linux/Windows) — overlay should appear
3. Copy some text to clipboard — it should appear in the overlay within ~500ms
4. Copy a few different things — history should build up, most recent first
5. Click an entry — it should paste into the active terminal and close the overlay
6. Press `Cmd+Shift+P`, type "Clipboard" — command palette entry should appear
7. Use arrow keys to navigate, Enter to paste, Escape to dismiss
8. Type in the filter input — entries should filter by text content

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(clipboard): address type/lint issues from integration"
```
