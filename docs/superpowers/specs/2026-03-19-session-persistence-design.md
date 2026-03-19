# Session State Persistence — Design Spec

## Problem

When users close and reopen Fleet, terminals start fresh with empty output. The workspace layout (tabs, panes, splits, CWDs) is restored, but all terminal scrollback is lost. Users lose context about what their AI agents were doing and must mentally reconstruct their session.

## Solution

Persist terminal scrollback content alongside the workspace layout so that reopening Fleet shows each terminal exactly as it looked when closed.

## Approach

**Inline scrollback in workspace JSON (Approach 1).** Serialize each terminal pane's visual content on close and embed it in the existing workspace tree structure. On reopen, restore it via the existing `serializedContent` prop.

This reuses all existing infrastructure: `SerializeAddon` for capture, `LayoutStore` (electron-store) for persistence, and the `serializedContent` terminal option for restore.

## Data Model Change

Add `serializedContent?: string` to `PaneLeaf` in `src/shared/types.ts`:

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
  serializedContent?: string;  // terminal scrollback snapshot
};
```

## Save Path (on app close)

In `App.tsx`'s `beforeunload` handler, walk the pane tree and serialize each terminal pane before saving:

```typescript
function injectSerializedContent(node: PaneNode): PaneNode {
  if (node.type === 'leaf') {
    if (node.paneType === 'file' || node.paneType === 'image') return node;
    const content = serializePane(node.id);
    return content ? { ...node, serializedContent: content } : node;
  }
  return {
    ...node,
    children: [
      injectSerializedContent(node.children[0]),
      injectSerializedContent(node.children[1]),
    ],
  };
}

const handleBeforeUnload = () => {
  const state = useWorkspaceStore.getState();
  const workspaceWithContent = {
    ...state.workspace,
    tabs: state.workspace.tabs.map((tab) => ({
      ...tab,
      splitRoot: injectSerializedContent(tab.splitRoot),
    })),
  };
  window.fleet.layout.save({ workspace: workspaceWithContent });
};
```

## Restore Path (on app open)

No new restore logic needed. The existing pipeline handles it:

1. `LayoutStore.load('default')` returns workspace with `serializedContent` on leaves
2. `WorkspaceStore.loadWorkspace()` sets state (passes through all fields)
3. `PaneGrid` renders each leaf — one line change to fall back to `node.serializedContent`
4. `useTerminal` already writes `serializedContent` to the terminal buffer on mount

The only restore change is in `PaneGrid.tsx` line 73:

```typescript
// Before:
serializedContent={serializedPanes?.get(node.id)}

// After:
serializedContent={serializedPanes?.get(node.id) ?? node.serializedContent}
```

The undo feature's `serializedPanes` Map takes priority when present; the persisted `serializedContent` on the leaf acts as fallback for session restore.

## Memory Cleanup

The `serializedContent` field stays on the leaf in memory after load. It is not explicitly stripped because:
- Terminals consume it on mount (write to buffer, then it's just a string in the zustand store)
- The next save cycle overwrites it with fresh serialized content
- Complexity of deferred cleanup outweighs the temporary memory cost

## Files Changed

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `serializedContent?: string` to `PaneLeaf` |
| `src/renderer/src/App.tsx` | Add `injectSerializedContent()` helper; use in `beforeunload` handler |
| `src/renderer/src/components/PaneGrid.tsx` | Fall back to `node.serializedContent` (1 line) |

## Scope

- **In scope:** Terminal scrollback persistence and restoration
- **Out of scope:** Process restoration (reconnecting to running PTYs), cursor position, scroll position, agent state checkpointing

## Risks

- **Large JSON files:** Rich TUI output (AI agents with colors) could produce 100KB–1MB per pane. For 10 panes, the workspace JSON could reach ~10MB. This is acceptable for electron-store but worth monitoring. If it becomes a problem, migrate to a separate scrollback store (Approach 2).
- **Stale content on crash:** If the app crashes without triggering `beforeunload`, the last saved scrollback may be outdated. This is acceptable — partial restore is better than no restore.
