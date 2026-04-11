# Pane Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named headers to terminal panes showing CWD path by default, with double-click or Shift+F2 to set a custom name. Headers only appear when 2+ panes exist in a tab.

**Architecture:** Extend `PaneLeaf` with optional `label`/`labelIsCustom` fields (mirrors the existing Tab pattern). Add a `PaneHeader` component rendered above terminal content in `PaneGrid.tsx`. Register `Shift+F2` shortcut for keyboard rename. Communicate rename-focus between shortcut handler and header via CustomEvent.

**Tech Stack:** React, TypeScript, Zustand, Tailwind CSS, xterm.js

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/types.ts` | Modify | Add `label?` and `labelIsCustom?` to `PaneLeaf` |
| `src/renderer/src/store/workspace-store.ts` | Modify | Add `renamePane` and `resetPaneLabel` actions |
| `src/renderer/src/lib/shortcuts.ts` | Modify | Add `rename-pane` shortcut definition |
| `src/renderer/src/lib/shorten-path.ts` | Create | Extract `shortenPath` utility from TabItem for reuse |
| `src/renderer/src/components/PaneHeader.tsx` | Create | Pane header bar with path display, inline edit, reset |
| `src/renderer/src/components/TabItem.tsx` | Modify | Import shared `shortenPath` instead of local copy |
| `src/renderer/src/components/PaneGrid.tsx` | Modify | Render `PaneHeader` above terminal panes when split |
| `src/renderer/src/hooks/use-pane-navigation.ts` | Modify | Handle `rename-pane` shortcut |

---

### Task 1: Extend PaneLeaf Type

**Files:**
- Modify: `src/shared/types.ts:35-45`

- [ ] **Step 1: Add label fields to PaneLeaf**

In `src/shared/types.ts`, add `label` and `labelIsCustom` to the `PaneLeaf` type:

```typescript
export type PaneLeaf = {
  type: 'leaf';
  id: string;
  ptyPid?: number;
  shell?: string;
  cwd: string;
  paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown';
  filePath?: string;
  isDirty?: boolean;
  serializedContent?: string;
  label?: string;
  labelIsCustom?: boolean;
};
```

- [ ] **Step 2: Run type check**

Run: `npm run typecheck`
Expected: PASS — fields are optional so all existing code is compatible.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(pane-naming): add label and labelIsCustom fields to PaneLeaf"
```

---

### Task 2: Add Store Actions

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts`

- [ ] **Step 1: Add renamePane and resetPaneLabel to the WorkspaceStore type**

In the `WorkspaceStore` type definition (around line 137-141, after the existing pane actions), add:

```typescript
  // Pane actions
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical') => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;
  resizeSplit: (splitNodePath: number[], ratio: number) => void;
  renamePane: (paneId: string, label: string) => void;
  resetPaneLabel: (paneId: string) => void;
```

- [ ] **Step 2: Implement renamePane action**

Add after the `resizeSplit` implementation (after line 647):

```typescript
  renamePane: (paneId, label) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: updateLeafInTree(tab.splitRoot, paneId, (leaf) => ({
            ...leaf,
            label,
            labelIsCustom: true
          }))
        }))
      },
      isDirty: true
    }));
  },
```

- [ ] **Step 3: Implement resetPaneLabel action**

Add immediately after `renamePane`:

```typescript
  resetPaneLabel: (paneId) => {
    set((state) => ({
      workspace: {
        ...state.workspace,
        tabs: state.workspace.tabs.map((tab) => ({
          ...tab,
          splitRoot: updateLeafInTree(tab.splitRoot, paneId, (leaf) => ({
            ...leaf,
            label: undefined,
            labelIsCustom: false
          }))
        }))
      },
      isDirty: true
    }));
  },
```

- [ ] **Step 4: Run type check**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts
git commit -m "feat(pane-naming): add renamePane and resetPaneLabel store actions"
```

---

### Task 3: Register Keyboard Shortcut

**Files:**
- Modify: `src/renderer/src/lib/shortcuts.ts`
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts`

- [ ] **Step 1: Add rename-pane shortcut definition**

In `src/renderer/src/lib/shortcuts.ts`, add to the `ALL_SHORTCUTS` array (after the `rename-tab` entry at line 97):

```typescript
  {
    id: 'rename-pane',
    label: 'Rename pane',
    mac: { key: 'F2', shift: true },
    other: { key: 'F2', shift: true }
  },
```

- [ ] **Step 2: Handle the shortcut in use-pane-navigation.ts**

In `src/renderer/src/hooks/use-pane-navigation.ts`, add after the F2 rename-tab handler (after line 27):

```typescript
      // Shift+F2 to rename active pane
      if (matchesShortcut(e, sc('rename-pane'))) {
        e.preventDefault();
        const state = useWorkspaceStore.getState();
        const activeTab = state.workspace.tabs.find((t) => t.id === state.activeTabId);
        // Only fire when there are 2+ panes (header is visible)
        if (activeTab && activeTab.splitRoot.type === 'split' && state.activePaneId) {
          document.dispatchEvent(
            new CustomEvent('fleet:rename-active-pane', {
              detail: { paneId: state.activePaneId }
            })
          );
        }
        return;
      }
```

Note: The `rename-pane` shortcut check must come **before** the `rename-tab` (F2) check, because Shift+F2 is a superset of F2. The `matchesShortcut` function checks `shift` strictly, so Shift+F2 won't match the non-shift F2 definition. But placing it first makes the intent clearer and avoids any future ambiguity.

- [ ] **Step 3: Run type check**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/shortcuts.ts src/renderer/src/hooks/use-pane-navigation.ts
git commit -m "feat(pane-naming): register Shift+F2 shortcut for pane rename"
```

---

### Task 4: Extract shortenPath Utility

**Files:**
- Create: `src/renderer/src/lib/shorten-path.ts`
- Modify: `src/renderer/src/components/TabItem.tsx`

- [ ] **Step 1: Create the shared utility**

Create `src/renderer/src/lib/shorten-path.ts`:

```typescript
const HOME = window.fleet.homeDir;

/** Shorten a CWD path for display: replaces home with ~, truncates long middle segments */
export function shortenPath(cwd: string): string {
  const withTilde = cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd;
  if (withTilde.length <= 30) return withTilde;
  const parts = withTilde.split('/').filter(Boolean);
  if (parts.length <= 2) return withTilde;
  const prefix = withTilde.startsWith('~') ? '~' : '';
  return `${prefix}/\u2026/${parts.slice(-2).join('/')}`;
}
```

- [ ] **Step 2: Update TabItem to use the shared utility**

In `src/renderer/src/components/TabItem.tsx`:

1. Remove the local `shortenPath` function (lines 14-21) and the `const HOME` line (line 12)
2. Add import at the top:

```typescript
import { shortenPath } from '../lib/shorten-path';
```

- [ ] **Step 3: Run type check**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/shorten-path.ts src/renderer/src/components/TabItem.tsx
git commit -m "refactor: extract shortenPath to shared utility for reuse"
```

---

### Task 5: Create PaneHeader Component

**Files:**
- Create: `src/renderer/src/components/PaneHeader.tsx`

- [ ] **Step 1: Create the PaneHeader component**

Create `src/renderer/src/components/PaneHeader.tsx`:

```typescript
import { useState, useEffect, useRef, useCallback } from 'react';
import { useCwdStore } from '../store/cwd-store';
import { useWorkspaceStore } from '../store/workspace-store';
import { shortenPath } from '../lib/shorten-path';

type PaneHeaderProps = {
  paneId: string;
  label?: string;
  labelIsCustom?: boolean;
};

export function PaneHeader({ paneId, label, labelIsCustom }: PaneHeaderProps): React.JSX.Element {
  const liveCwd = useCwdStore((s) => s.cwds.get(paneId));
  const renamePane = useWorkspaceStore((s) => s.renamePane);
  const resetPaneLabel = useWorkspaceStore((s) => s.resetPaneLabel);

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const displayText = labelIsCustom && label ? label : shortenPath(liveCwd ?? '');

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Listen for Shift+F2 rename event targeting this pane
  useEffect(() => {
    const handler = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const detail = e.detail as { paneId?: string } | undefined;
      if (detail?.paneId === paneId) {
        setEditValue(displayText);
        setIsEditing(true);
      }
    };
    document.addEventListener('fleet:rename-active-pane', handler);
    return () => document.removeEventListener('fleet:rename-active-pane', handler);
  }, [paneId, displayText]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== displayText) {
      renamePane(paneId, trimmed);
    }
    setIsEditing(false);
  }, [editValue, displayText, renamePane, paneId]);

  const handleDoubleClick = useCallback(() => {
    setEditValue(displayText);
    setIsEditing(true);
  }, [displayText]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        commitRename();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
      }
    },
    [commitRename]
  );

  return (
    <div className="flex items-center h-6 px-2 bg-neutral-900 border-b border-neutral-800 text-xs text-neutral-400 select-none shrink-0">
      {isEditing ? (
        <input
          ref={inputRef}
          className="flex-1 bg-transparent text-neutral-200 text-xs font-mono outline-none border-none px-0"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <span
          className="flex-1 truncate font-mono cursor-default"
          onDoubleClick={handleDoubleClick}
          title={liveCwd ?? ''}
        >
          {displayText}
        </span>
      )}
      {labelIsCustom && !isEditing && (
        <button
          className="ml-1 text-neutral-500 hover:text-neutral-300 transition-colors"
          onClick={() => resetPaneLabel(paneId)}
          title="Reset to path"
          aria-label="Reset pane name"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 2l6 6M8 2l-6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run type check**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/PaneHeader.tsx
git commit -m "feat(pane-naming): create PaneHeader component with path display and inline edit"
```

---

### Task 6: Integrate PaneHeader into PaneGrid

**Files:**
- Modify: `src/renderer/src/components/PaneGrid.tsx`

- [ ] **Step 1: Add PaneHeader import**

At the top of `src/renderer/src/components/PaneGrid.tsx`, add:

```typescript
import { PaneHeader } from './PaneHeader';
```

- [ ] **Step 2: Pass splitRoot to PaneGrid and determine if multi-pane**

The `PaneGrid` component already receives `root: PaneNode`. The header should render when `root.type === 'split'`. No new props needed — the existing `root` prop tells us whether we're in a multi-pane layout.

- [ ] **Step 3: Update terminal pane rendering to include header**

In `PaneGrid.tsx`, replace the terminal pane rendering block (lines 172-187):

```typescript
        return (
          <div key={leaf.id} style={rectStyle(leaf.rect)} className="flex flex-col">
            {root.type === 'split' && (
              <PaneHeader
                paneId={leaf.id}
                label={leaf.node.label}
                labelIsCustom={leaf.node.labelIsCustom}
              />
            )}
            <div className="flex-1 min-h-0">
              <TerminalPane
                paneId={leaf.id}
                cwd={leaf.node.cwd}
                isActive={leaf.id === activePaneId}
                onFocus={() => onPaneFocus(leaf.id)}
                serializedContent={serializedPanes?.get(leaf.id) ?? leaf.node.serializedContent}
                fontFamily={fontFamily}
                fontSize={fontSize}
                onSplitHorizontal={() => splitPane(leaf.id, 'horizontal')}
                onSplitVertical={() => splitPane(leaf.id, 'vertical')}
                onClose={() => closePane(leaf.id)}
              />
            </div>
          </div>
        );
```

Key changes:
- Outer div gets `className="flex flex-col"` for vertical stacking
- `PaneHeader` conditionally rendered when `root.type === 'split'`
- `TerminalPane` wrapped in a `flex-1 min-h-0` div so it fills remaining height after the header

- [ ] **Step 4: Run type check**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/PaneGrid.tsx
git commit -m "feat(pane-naming): render PaneHeader above terminal panes when split"
```

---

### Task 7: Build Verification and Manual Testing

**Files:** None (testing only)

- [ ] **Step 1: Run full type check**

Run: `npm run typecheck`
Expected: PASS with no errors

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (fix any lint errors that appear)

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — clean build

- [ ] **Step 4: Manual testing checklist**

Start the dev server and test in a browser:

Run: `npm run dev`

Test each scenario:

1. **Single pane tab:** Open a terminal tab — no header should be visible
2. **Split pane:** Hit Cmd+D to split right — both panes should now show headers with CWD paths
3. **Double-click rename:** Double-click a header — input appears, type a name, press Enter — custom name displays
4. **Escape cancel:** Double-click to edit, press Escape — edit cancelled, original text remains
5. **Reset button:** After setting a custom name, click the x button — reverts to CWD path
6. **Shift+F2 rename:** Focus a pane, press Shift+F2 — input appears on the active pane's header
7. **Close to single pane:** Close one pane so only one remains — header should disappear
8. **Persistence:** Set a custom pane name, reload the app — the name should persist
9. **Live CWD update:** `cd` to a different directory in a pane — header path updates automatically

- [ ] **Step 5: Commit any fixes**

If any issues were found during testing, fix and commit:

```bash
git add -u
git commit -m "fix(pane-naming): address issues found during manual testing"
```
