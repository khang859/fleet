# Session State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist terminal scrollback content so reopening Fleet shows each terminal as it looked when closed.

**Architecture:** Serialize each terminal pane's visual content via xterm.js `SerializeAddon` on app close, embed it in the existing workspace JSON (electron-store `PaneLeaf` type), and restore it on reopen via the existing `serializedContent` terminal option. Three files changed, ~20 lines added.

**Tech Stack:** Electron, React, TypeScript, xterm.js (SerializeAddon), electron-store, zustand

**Spec:** `docs/superpowers/specs/2026-03-19-session-persistence-design.md`

---

### Task 1: Add `serializedContent` to `PaneLeaf` type

**Files:**

- Modify: `src/shared/types.ts:26-35`

- [ ] **Step 1: Add the field to the PaneLeaf type**

In `src/shared/types.ts`, add `serializedContent?: string` to the `PaneLeaf` type after `isDirty`:

```typescript
export type PaneLeaf = {
  type: 'leaf';
  id: string;
  ptyPid?: number;
  shell?: string;
  cwd: string;
  paneType?: 'terminal' | 'file' | 'image';
  filePath?: string;
  isDirty?: boolean;
  serializedContent?: string;
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/khangnguyen/Development/fleet/.claude/worktrees/luminous-petting-island && npx tsc --noEmit`
Expected: No new errors (field is optional, so all existing code remains valid).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat: add serializedContent field to PaneLeaf type"
```

---

### Task 2: Serialize terminal content on app close

**Files:**

- Modify: `src/renderer/src/App.tsx:1-178`

- [ ] **Step 1: Add the `injectSerializedContent` helper**

Add this import and helper function near the top of `App.tsx`, after the existing `killClosedTabPtys` function (after line 32):

```typescript
import type { PaneNode } from '../../shared/types';

function injectSerializedContent(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    if (node.paneType === 'file' || node.paneType === 'image') return node;
    const content = serializePane(node.id);
    return content ? { ...node, serializedContent: content } : node;
  }
  return {
    ...node,
    children: [injectSerializedContent(node.children[0]), injectSerializedContent(node.children[1])]
  };
}
```

Note: `serializePane` is already imported at line 10. `PaneNode` needs to be added as a new import.

- [ ] **Step 2: Update the `beforeunload` handler to inject serialized content**

Change the `handleBeforeUnload` function (lines 172-175) from:

```typescript
const handleBeforeUnload = () => {
  const state = useWorkspaceStore.getState();
  window.fleet.layout.save({ workspace: state.workspace });
};
```

To:

```typescript
const handleBeforeUnload = () => {
  const state = useWorkspaceStore.getState();
  const workspaceWithContent = {
    ...state.workspace,
    tabs: state.workspace.tabs.map((tab) => ({
      ...tab,
      splitRoot: injectSerializedContent(tab.splitRoot)
    }))
  };
  window.fleet.layout.save({ workspace: workspaceWithContent });
};
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /Users/khangnguyen/Development/fleet/.claude/worktrees/luminous-petting-island && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat: serialize terminal content on app close for session persistence"
```

---

### Task 3: Restore serialized content on app open

**Files:**

- Modify: `src/renderer/src/components/PaneGrid.tsx:73`

- [ ] **Step 1: Fall back to `node.serializedContent` in PaneNodeRenderer**

In `PaneGrid.tsx`, change line 73 from:

```typescript
serializedContent={serializedPanes?.get(node.id)}
```

To:

```typescript
// Undo's serializedPanes takes priority; persisted node.serializedContent is fallback for session restore
serializedContent={serializedPanes?.get(node.id) ?? node.serializedContent}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/khangnguyen/Development/fleet/.claude/worktrees/luminous-petting-island && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/PaneGrid.tsx
git commit -m "feat: restore persisted terminal content on session load"
```

---

### Task 4: Build verification

- [ ] **Step 1: Run full build**

Run: `cd /Users/khangnguyen/Development/fleet/.claude/worktrees/luminous-petting-island && npm run build`
Expected: Build succeeds with no errors.

- [ ] **Step 2: Manual smoke test (if running locally)**

1. Start Fleet: `npm run dev`
2. Open a terminal tab, run a few commands (e.g. `ls -la`, `echo "hello"`)
3. Quit Fleet (Cmd+Q)
4. Reopen Fleet: `npm run dev`
5. Verify: the terminal shows the previous scrollback output
6. Verify: the terminal has a fresh shell prompt at the bottom (new PTY, old content above)
