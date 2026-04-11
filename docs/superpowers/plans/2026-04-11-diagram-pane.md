# Diagram Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a React Flow-based diagram pane to Fleet that supports rich visual editing, two-way file sync, and codebase analysis commands.

**Architecture:** New `diagram` pane type rendered by `DiagramPane` component using `@xyflow/react`. Main process handles file watching and atomic writes via new IPC channels. Codebase analyzer runs static import scanning and AI-powered analysis via copilot socket. State is managed per-pane with Zustand stores.

**Tech Stack:** @xyflow/react (React Flow v12), @dagrejs/dagre (auto-layout), existing Zustand + Tailwind + Radix stack.

**Spec:** `docs/superpowers/specs/2026-04-11-diagram-pane-design.md`

**Deferred to v2:** AI-powered architecture analysis (the "Diagram: Architecture (AI)" command). This requires copilot socket integration which is complex and independent of the core diagram feature. All other spec requirements are covered.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/renderer/src/components/diagram/DiagramPane.tsx` | Top-level pane component — loads file, wires React Flow, manages sync |
| `src/renderer/src/components/diagram/DiagramToolbar.tsx` | Toolbar: add node, undo/redo, zoom, auto-layout, export |
| `src/renderer/src/components/diagram/PropertiesPanel.tsx` | Right sidebar for editing selected node/edge properties |
| `src/renderer/src/components/diagram/NodeContextMenu.tsx` | Right-click context menu on canvas/nodes/edges |
| `src/renderer/src/components/diagram/nodes/MarkdownNode.tsx` | Custom React Flow node: renders markdown content |
| `src/renderer/src/components/diagram/nodes/ImageNode.tsx` | Custom React Flow node: displays an image |
| `src/renderer/src/components/diagram/nodes/GroupNode.tsx` | Custom React Flow node: container for child nodes |
| `src/renderer/src/components/diagram/use-diagram-store.ts` | Per-pane Zustand store factory: nodes, edges, history, sync state |
| `src/renderer/src/components/diagram/use-diagram-sync.ts` | Hook: two-way sync between store and file (debounced write-back + file change listener) |
| `src/renderer/src/components/diagram/use-diagram-history.ts` | Hook: undo/redo snapshot history |
| `src/renderer/src/components/diagram/layout.ts` | Dagre auto-layout helper |
| `src/renderer/src/components/diagram/types.ts` | FleetDiagram file format types (meta envelope + React Flow data) |
| `src/renderer/src/components/diagram/export.ts` | PNG/SVG export helpers |
| `src/main/diagram-watcher.ts` | Main process: file watcher registry for diagram files |
| `src/main/diagram-analyzer.ts` | Main process: static analysis (dependency graph, directory structure) |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/types.ts:15,41` | Add `'diagram'` to Tab.type and PaneLeaf.paneType unions |
| `src/shared/ipc-channels.ts:96` | Add DIAGRAM_* IPC channel constants |
| `src/main/ipc-handlers.ts` | Register diagram IPC handlers (watch, unwatch, save, analyze) |
| `src/preload/index.ts` | Expose `window.fleet.diagram.*` API |
| `src/renderer/src/components/PaneGrid.tsx:172` | Add `paneType === 'diagram'` rendering branch |
| `src/renderer/src/store/workspace-store.ts:894-916` | Update `openFile` to detect `.fleet-diagram.json` → diagram pane |
| `src/renderer/src/components/Sidebar.tsx:1152-1162` | Add diagram icon mapping |
| `src/renderer/src/lib/commands.ts` | Add diagram commands to command palette |
| `package.json` | Add `@xyflow/react` and `@dagrejs/dagre` dependencies |

---

## Task 1: Install Dependencies and Add Type Foundations

**Files:**
- Modify: `package.json`
- Modify: `src/shared/types.ts:15,41`
- Create: `src/renderer/src/components/diagram/types.ts`

- [ ] **Step 1: Install @xyflow/react and @dagrejs/dagre**

```bash
npm install @xyflow/react @dagrejs/dagre
npm install -D @types/d3-hierarchy  # dagre's transitive type dep
```

Run: `npm ls @xyflow/react @dagrejs/dagre`
Expected: Both packages listed with versions.

- [ ] **Step 2: Add 'diagram' to PaneLeaf.paneType union**

In `src/shared/types.ts`, line 41, change:

```typescript
paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown';
```

to:

```typescript
paneType?: 'terminal' | 'file' | 'image' | 'images' | 'pi' | 'markdown' | 'diagram';
```

- [ ] **Step 3: Add 'diagram' to Tab.type union**

In `src/shared/types.ts`, line 15, change:

```typescript
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown';
```

to:

```typescript
type?: 'terminal' | 'file' | 'image' | 'images' | 'settings' | 'annotate' | 'pi' | 'markdown' | 'diagram';
```

- [ ] **Step 4: Create diagram file format types**

Create `src/renderer/src/components/diagram/types.ts`:

```typescript
import type { Node, Edge, Viewport } from '@xyflow/react';

export type FleetDiagramMeta = {
  title: string;
  createdBy?: string;
  createdAt?: string;
};

export type FleetDiagramFile = {
  version: 1;
  meta: FleetDiagramMeta;
  nodes: Node[];
  edges: Edge[];
  viewport?: Viewport;
};

export function createEmptyDiagram(title: string): FleetDiagramFile {
  return {
    version: 1,
    meta: { title, createdAt: new Date().toISOString() },
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export function parseDiagramFile(json: string): FleetDiagramFile | null {
  try {
    const data = JSON.parse(json);
    if (data?.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      return null;
    }
    return data as FleetDiagramFile;
  } catch {
    return null;
  }
}

export function serializeDiagramFile(diagram: FleetDiagramFile): string {
  return JSON.stringify(diagram, null, 2);
}
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/shared/types.ts src/renderer/src/components/diagram/types.ts
git commit -m "feat(diagram): install react flow, add diagram type foundations"
```

---

## Task 2: IPC Channels, Main Process Watcher, and Preload API

**Files:**
- Modify: `src/shared/ipc-channels.ts:96`
- Create: `src/main/diagram-watcher.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/ipc-channels.ts`, before the closing `} as const;` on line 96, add:

```typescript
  // Diagram
  DIAGRAM_WATCH: 'diagram:watch',
  DIAGRAM_UNWATCH: 'diagram:unwatch',
  DIAGRAM_SAVE: 'diagram:save',
  DIAGRAM_FILE_CHANGED: 'diagram:file-changed',
  DIAGRAM_ANALYZE_DEPS: 'diagram:analyze-deps',
  DIAGRAM_ANALYZE_DIRS: 'diagram:analyze-dirs',
```

- [ ] **Step 2: Create the diagram file watcher**

Create `src/main/diagram-watcher.ts`:

```typescript
import { watch, readFile, writeFile, rename, type FSWatcher } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';

type WatchEntry = {
  watcher: FSWatcher;
  lastWriteId: string | null;
};

export class DiagramWatcher {
  private entries = new Map<string, WatchEntry>();

  constructor(private getWindow: () => BrowserWindow | null) {}

  watch(filePath: string): void {
    if (this.entries.has(filePath)) return;

    const watcher = watch(filePath, { persistent: false }, () => {
      const entry = this.entries.get(filePath);
      if (!entry) return;

      readFile(filePath, 'utf-8', (err, content) => {
        if (err) return;

        // Check if this change was triggered by our own save
        try {
          const parsed = JSON.parse(content);
          if (parsed._writeId && parsed._writeId === entry.lastWriteId) {
            // Our own write — ignore
            return;
          }
        } catch {
          // Not valid JSON, still notify
        }

        const win = this.getWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.DIAGRAM_FILE_CHANGED, { filePath, content });
        }
      });
    });

    this.entries.set(filePath, { watcher, lastWriteId: null });
  }

  unwatch(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry) {
      entry.watcher.close();
      this.entries.delete(filePath);
    }
  }

  async save(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    try {
      const writeId = randomUUID();
      const entry = this.entries.get(filePath);
      if (entry) entry.lastWriteId = writeId;

      // Inject writeId for echo detection, then strip it before writing
      // Actually, we embed it in the JSON temporarily
      const parsed = JSON.parse(content);
      parsed._writeId = writeId;
      const withId = JSON.stringify(parsed, null, 2);

      // Atomic write: write to temp, rename
      const tmpPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
      await new Promise<void>((resolve, reject) =>
        writeFile(tmpPath, withId, 'utf-8', (err) => (err ? reject(err) : resolve()))
      );
      await new Promise<void>((resolve, reject) =>
        rename(tmpPath, filePath, (err) => (err ? reject(err) : resolve()))
      );

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.watcher.close();
    }
    this.entries.clear();
  }
}
```

- [ ] **Step 3: Register IPC handlers in ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, add at the top with other imports:

```typescript
import { DiagramWatcher } from './diagram-watcher';
```

Inside `registerIpcHandlers`, after the existing file operation handlers, add:

```typescript
  // Diagram
  const diagramWatcher = new DiagramWatcher(getWindow);

  ipcMain.handle(IPC_CHANNELS.DIAGRAM_WATCH, async (_event, filePath: string) => {
    diagramWatcher.watch(filePath);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.DIAGRAM_UNWATCH, async (_event, filePath: string) => {
    diagramWatcher.unwatch(filePath);
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.DIAGRAM_SAVE,
    async (_event, { filePath, content }: { filePath: string; content: string }) => {
      return diagramWatcher.save(filePath, content);
    }
  );
```

- [ ] **Step 4: Expose diagram API in preload**

In `src/preload/index.ts`, inside the `fleetApi` object, add a `diagram` namespace (after the `file` namespace):

```typescript
  diagram: {
    watch: async (filePath: string): Promise<{ success: boolean }> =>
      typedInvoke(IPC_CHANNELS.DIAGRAM_WATCH, filePath),
    unwatch: async (filePath: string): Promise<{ success: boolean }> =>
      typedInvoke(IPC_CHANNELS.DIAGRAM_UNWATCH, filePath),
    save: async (
      filePath: string,
      content: string
    ): Promise<{ success: boolean; error?: string }> =>
      typedInvoke(IPC_CHANNELS.DIAGRAM_SAVE, { filePath, content }),
    onFileChanged: (
      callback: (payload: { filePath: string; content: string }) => void
    ): Unsubscribe => onChannel(IPC_CHANNELS.DIAGRAM_FILE_CHANGED, callback),
  },
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/diagram-watcher.ts src/main/ipc-handlers.ts src/preload/index.ts
git commit -m "feat(diagram): add IPC channels, file watcher, and preload API"
```

---

## Task 3: Per-Pane Zustand Store and History Hook

**Files:**
- Create: `src/renderer/src/components/diagram/use-diagram-store.ts`
- Create: `src/renderer/src/components/diagram/use-diagram-history.ts`

- [ ] **Step 1: Create the per-pane Zustand store factory**

Create `src/renderer/src/components/diagram/use-diagram-store.ts`:

```typescript
import { createStore, type StoreApi } from 'zustand';
import type { Node, Edge, Viewport, NodeChange, EdgeChange, Connection } from '@xyflow/react';
import { applyNodeChanges, applyEdgeChanges, addEdge } from '@xyflow/react';
import type { FleetDiagramMeta } from './types';

export type DiagramSnapshot = {
  nodes: Node[];
  edges: Edge[];
};

export type DiagramState = {
  // Data
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  meta: FleetDiagramMeta;

  // Sync state
  filePath: string;
  isDirty: boolean;
  lastWriteId: string | null;

  // History
  past: DiagramSnapshot[];
  future: DiagramSnapshot[];

  // Selection
  selectedNodeIds: Set<string>;
  selectedEdgeIds: Set<string>;

  // Actions
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setViewport: (viewport: Viewport) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  setMeta: (meta: Partial<FleetDiagramMeta>) => void;
  setDirty: (dirty: boolean) => void;
  setLastWriteId: (id: string | null) => void;

  // History actions
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  // Selection
  setSelection: (nodeIds: string[], edgeIds: string[]) => void;
};

const MAX_HISTORY = 100;

export function createDiagramStore(filePath: string): StoreApi<DiagramState> {
  return createStore<DiagramState>((set, get) => ({
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    meta: { title: '' },
    filePath,
    isDirty: false,
    lastWriteId: null,
    past: [],
    future: [],
    selectedNodeIds: new Set(),
    selectedEdgeIds: new Set(),

    setNodes: (nodes) => set({ nodes, isDirty: true }),
    setEdges: (edges) => set({ edges, isDirty: true }),
    setViewport: (viewport) => set({ viewport }),

    onNodesChange: (changes) =>
      set((state) => ({ nodes: applyNodeChanges(changes, state.nodes), isDirty: true })),
    onEdgesChange: (changes) =>
      set((state) => ({ edges: applyEdgeChanges(changes, state.edges), isDirty: true })),
    onConnect: (connection) =>
      set((state) => ({ edges: addEdge(connection, state.edges), isDirty: true })),

    setMeta: (meta) => set((state) => ({ meta: { ...state.meta, ...meta } })),
    setDirty: (isDirty) => set({ isDirty }),
    setLastWriteId: (lastWriteId) => set({ lastWriteId }),

    pushHistory: () =>
      set((state) => ({
        past: [...state.past.slice(-(MAX_HISTORY - 1)), { nodes: state.nodes, edges: state.edges }],
        future: [],
      })),

    undo: () => {
      const { past, nodes, edges } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      set({
        past: past.slice(0, -1),
        future: [{ nodes, edges }, ...get().future],
        nodes: prev.nodes,
        edges: prev.edges,
        isDirty: true,
      });
    },

    redo: () => {
      const { future, nodes, edges } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        future: future.slice(1),
        past: [...get().past, { nodes, edges }],
        nodes: next.nodes,
        edges: next.edges,
        isDirty: true,
      });
    },

    setSelection: (nodeIds, edgeIds) =>
      set({ selectedNodeIds: new Set(nodeIds), selectedEdgeIds: new Set(edgeIds) }),
  }));
}
```

- [ ] **Step 2: Create the history hook**

Create `src/renderer/src/components/diagram/use-diagram-history.ts`:

```typescript
import { useEffect, useCallback, useRef } from 'react';
import type { StoreApi } from 'zustand';
import type { DiagramState } from './use-diagram-store';

/**
 * Captures a history snapshot on meaningful actions (not intermediate drags).
 * Call `captureSnapshot` before destructive operations (delete, add, style change).
 * Drag-end is handled by onNodeDragStop.
 */
export function useDiagramHistory(store: StoreApi<DiagramState>) {
  const captureSnapshot = useCallback(() => {
    store.getState().pushHistory();
  }, [store]);

  // Keyboard undo/redo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        store.getState().undo();
      }
      if (isMod && e.key === 'z' && e.shiftKey) {
        e.preventDefault();
        store.getState().redo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [store]);

  return { captureSnapshot };
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/diagram/use-diagram-store.ts src/renderer/src/components/diagram/use-diagram-history.ts
git commit -m "feat(diagram): add per-pane Zustand store and undo/redo history"
```

---

## Task 4: Two-Way File Sync Hook

**Files:**
- Create: `src/renderer/src/components/diagram/use-diagram-sync.ts`

- [ ] **Step 1: Create the sync hook**

Create `src/renderer/src/components/diagram/use-diagram-sync.ts`:

```typescript
import { useEffect, useRef, useCallback } from 'react';
import type { StoreApi } from 'zustand';
import type { DiagramState } from './use-diagram-store';
import { parseDiagramFile, serializeDiagramFile } from './types';
import type { FleetDiagramFile } from './types';

const DEBOUNCE_MS = 300;

/**
 * Two-way sync between the diagram store and a .fleet-diagram.json file.
 * - Store → File: debounced writes on every change.
 * - File → Store: listens for external file changes via IPC.
 */
export function useDiagramSync(
  store: StoreApi<DiagramState>,
  filePath: string,
  onLoaded: (diagram: FleetDiagramFile) => void,
  onError: (error: string) => void
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDraggingRef = useRef(false);
  const pendingExternalRef = useRef<string | null>(null);

  // Load the file initially
  useEffect(() => {
    void window.fleet.file.read(filePath).then((result) => {
      if (result.success && result.data) {
        const diagram = parseDiagramFile(result.data.content);
        if (diagram) {
          onLoaded(diagram);
        } else {
          onError('Invalid diagram file format');
        }
      } else {
        onError('error' in result ? result.error : 'Failed to read file');
      }
    });
  }, [filePath, onLoaded, onError]);

  // Start watching the file
  useEffect(() => {
    void window.fleet.diagram.watch(filePath);
    return () => {
      void window.fleet.diagram.unwatch(filePath);
    };
  }, [filePath]);

  // Listen for external file changes
  useEffect(() => {
    const unsub = window.fleet.diagram.onFileChanged((payload) => {
      if (payload.filePath !== filePath) return;

      const diagram = parseDiagramFile(payload.content);
      if (!diagram) return;

      if (isDraggingRef.current) {
        // Queue the update until drag ends
        pendingExternalRef.current = payload.content;
        return;
      }

      const state = store.getState();
      state.setNodes(diagram.nodes);
      state.setEdges(diagram.edges);
      if (diagram.viewport) state.setViewport(diagram.viewport);
      if (diagram.meta) state.setMeta(diagram.meta);
      state.setDirty(false);
    });

    return unsub;
  }, [filePath, store]);

  // Debounced write-back to file
  const scheduleWrite = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const state = store.getState();
      const diagram: FleetDiagramFile = {
        version: 1,
        meta: state.meta,
        nodes: state.nodes,
        edges: state.edges,
        viewport: state.viewport,
      };
      const content = serializeDiagramFile(diagram);
      void window.fleet.diagram.save(filePath, content).then((result) => {
        if (result.success) {
          store.getState().setDirty(false);
        }
      });
    }, DEBOUNCE_MS);
  }, [store, filePath]);

  // Subscribe to store changes and trigger write-back
  useEffect(() => {
    let prevNodes = store.getState().nodes;
    let prevEdges = store.getState().edges;
    let prevViewport = store.getState().viewport;

    const unsub = store.subscribe((state) => {
      if (
        state.nodes !== prevNodes ||
        state.edges !== prevEdges ||
        state.viewport !== prevViewport
      ) {
        prevNodes = state.nodes;
        prevEdges = state.edges;
        prevViewport = state.viewport;
        scheduleWrite();
      }
    });

    return () => {
      unsub();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [store, scheduleWrite]);

  // Drag state helpers — call these from DiagramPane
  const setDragging = useCallback(
    (dragging: boolean) => {
      isDraggingRef.current = dragging;
      if (!dragging && pendingExternalRef.current) {
        // Apply queued external update
        const diagram = parseDiagramFile(pendingExternalRef.current);
        pendingExternalRef.current = null;
        if (diagram) {
          const state = store.getState();
          state.setNodes(diagram.nodes);
          state.setEdges(diagram.edges);
          if (diagram.viewport) state.setViewport(diagram.viewport);
          state.setDirty(false);
        }
      }
    },
    [store]
  );

  return { setDragging };
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/diagram/use-diagram-sync.ts
git commit -m "feat(diagram): add two-way file sync hook with debounced writes"
```

---

## Task 5: Auto-Layout Helper

**Files:**
- Create: `src/renderer/src/components/diagram/layout.ts`

- [ ] **Step 1: Create the dagre layout helper**

Create `src/renderer/src/components/diagram/layout.ts`:

```typescript
import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

export type LayoutDirection = 'TB' | 'LR';

const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 40;

export function autoLayout(
  nodes: Node[],
  edges: Edge[],
  direction: LayoutDirection = 'TB'
): Node[] {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, nodesep: 60, ranksep: 80 });

  // Separate top-level nodes and children
  const childrenByParent = new Map<string, Node[]>();
  const topLevel: Node[] = [];

  for (const node of nodes) {
    if (node.parentId) {
      const siblings = childrenByParent.get(node.parentId) ?? [];
      siblings.push(node);
      childrenByParent.set(node.parentId, siblings);
    } else {
      topLevel.push(node);
    }
  }

  for (const node of topLevel) {
    const w = (node.measured?.width ?? node.width) || DEFAULT_NODE_WIDTH;
    const h = (node.measured?.height ?? node.height) || DEFAULT_NODE_HEIGHT;
    g.setNode(node.id, { width: w, height: h });
  }

  for (const edge of edges) {
    // Only add edges between top-level nodes to dagre
    const srcTop = !nodes.find((n) => n.id === edge.source)?.parentId;
    const tgtTop = !nodes.find((n) => n.id === edge.target)?.parentId;
    if (srcTop && tgtTop) {
      g.setEdge(edge.source, edge.target);
    }
  }

  dagre.layout(g);

  const positioned = nodes.map((node) => {
    if (node.parentId) return node; // children keep relative positions

    const pos = g.node(node.id);
    if (!pos) return node;

    const w = (node.measured?.width ?? node.width) || DEFAULT_NODE_WIDTH;
    const h = (node.measured?.height ?? node.height) || DEFAULT_NODE_HEIGHT;

    return {
      ...node,
      position: { x: pos.x - w / 2, y: pos.y - h / 2 },
    };
  });

  return positioned;
}

/**
 * Returns true if all top-level nodes are at position (0,0) — meaning no layout has been applied.
 */
export function needsAutoLayout(nodes: Node[]): boolean {
  const topLevel = nodes.filter((n) => !n.parentId);
  if (topLevel.length <= 1) return false;
  return topLevel.every((n) => n.position.x === 0 && n.position.y === 0);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/diagram/layout.ts
git commit -m "feat(diagram): add dagre auto-layout helper"
```

---

## Task 6: Custom Node Types (Markdown, Image, Group)

**Files:**
- Create: `src/renderer/src/components/diagram/nodes/MarkdownNode.tsx`
- Create: `src/renderer/src/components/diagram/nodes/ImageNode.tsx`
- Create: `src/renderer/src/components/diagram/nodes/GroupNode.tsx`

- [ ] **Step 1: Create MarkdownNode**

Create `src/renderer/src/components/diagram/nodes/MarkdownNode.tsx`:

```typescript
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type MarkdownNodeData = {
  label?: string;
  markdown: string;
};

export const MarkdownNode = memo(function MarkdownNode({ data }: NodeProps) {
  const { markdown = '', label } = data as MarkdownNodeData;

  return (
    <div className="rounded-lg border border-neutral-600 bg-neutral-800 p-3 text-neutral-200 min-w-[160px] max-w-[400px]">
      <Handle type="target" position={Position.Top} className="!bg-teal-500" />
      {label && <div className="mb-1 text-xs font-semibold text-neutral-400">{label}</div>}
      <div className="prose prose-invert prose-sm max-w-none">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-teal-500" />
    </div>
  );
});
```

- [ ] **Step 2: Create ImageNode**

Create `src/renderer/src/components/diagram/nodes/ImageNode.tsx`:

```typescript
import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

type ImageNodeData = {
  label?: string;
  src: string;
  width?: number;
  height?: number;
};

export const ImageNode = memo(function ImageNode({ data }: NodeProps) {
  const { src, label, width = 200, height } = data as ImageNodeData;
  // Use fleet-image protocol for local files
  const imageSrc = src.startsWith('http') ? src : `fleet-image://${src}`;

  return (
    <div className="rounded-lg border border-neutral-600 bg-neutral-800 p-2 text-neutral-200">
      <Handle type="target" position={Position.Top} className="!bg-teal-500" />
      {label && <div className="mb-1 text-xs font-semibold text-neutral-400">{label}</div>}
      <img
        src={imageSrc}
        alt={label ?? 'diagram image'}
        style={{ width, height: height ?? 'auto' }}
        className="rounded"
      />
      <Handle type="source" position={Position.Bottom} className="!bg-teal-500" />
    </div>
  );
});
```

- [ ] **Step 3: Create GroupNode**

Create `src/renderer/src/components/diagram/nodes/GroupNode.tsx`:

```typescript
import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';

type GroupNodeData = {
  label?: string;
};

export const GroupNode = memo(function GroupNode({ data }: NodeProps) {
  const { label } = data as GroupNodeData;

  return (
    <div className="rounded-xl border-2 border-dashed border-neutral-600 bg-neutral-900/50 p-4 min-w-[200px] min-h-[100px]">
      {label && (
        <div className="absolute -top-3 left-3 rounded bg-neutral-800 px-2 text-xs font-semibold text-neutral-400">
          {label}
        </div>
      )}
    </div>
  );
});
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/diagram/nodes/
git commit -m "feat(diagram): add custom node types (markdown, image, group)"
```

---

## Task 7: DiagramPane Component (Core)

**Files:**
- Create: `src/renderer/src/components/diagram/DiagramPane.tsx`
- Modify: `src/renderer/src/components/PaneGrid.tsx:172`

- [ ] **Step 1: Create DiagramPane**

Create `src/renderer/src/components/diagram/DiagramPane.tsx`:

```typescript
import { useState, useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from 'zustand';
import { createDiagramStore, type DiagramState } from './use-diagram-store';
import { useDiagramSync } from './use-diagram-sync';
import { useDiagramHistory } from './use-diagram-history';
import { autoLayout, needsAutoLayout } from './layout';
import { MarkdownNode } from './nodes/MarkdownNode';
import { ImageNode } from './nodes/ImageNode';
import { GroupNode } from './nodes/GroupNode';
import type { FleetDiagramFile } from './types';

const nodeTypes = {
  markdown: MarkdownNode,
  image: ImageNode,
  group: GroupNode,
};

type Props = {
  paneId: string;
  filePath: string;
};

function DiagramPaneInner({ paneId, filePath }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const storeRef = useRef(createDiagramStore(filePath));
  const store = storeRef.current;

  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const viewport = useStore(store, (s) => s.viewport);
  const onNodesChange = useStore(store, (s) => s.onNodesChange);
  const onEdgesChange = useStore(store, (s) => s.onEdgesChange);
  const onConnect = useStore(store, (s) => s.onConnect);
  const setViewport = useStore(store, (s) => s.setViewport);

  const { captureSnapshot } = useDiagramHistory(store);

  const onLoaded = useCallback(
    (diagram: FleetDiagramFile) => {
      const state = store.getState();
      let loadedNodes = diagram.nodes;

      // Auto-layout if all nodes are at (0,0)
      if (needsAutoLayout(loadedNodes)) {
        loadedNodes = autoLayout(loadedNodes, diagram.edges);
      }

      state.setNodes(loadedNodes);
      state.setEdges(diagram.edges);
      if (diagram.viewport) state.setViewport(diagram.viewport);
      if (diagram.meta) state.setMeta(diagram.meta);
      state.setDirty(false);
      setLoading(false);
    },
    [store]
  );

  const onError = useCallback((msg: string) => {
    setError(msg);
    setLoading(false);
  }, []);

  const { setDragging } = useDiagramSync(store, filePath, onLoaded, onError);

  const onSelectionChange = useCallback(
    ({ nodes: selNodes, edges: selEdges }: OnSelectionChangeParams) => {
      store.getState().setSelection(
        selNodes.map((n) => n.id),
        selEdges.map((e) => e.id)
      );
    },
    [store]
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-500">
        Loading diagram…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full w-full" data-pane-id={paneId}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        defaultViewport={viewport}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onMoveEnd={(_event, vp) => setViewport(vp)}
        onNodeDragStart={() => {
          captureSnapshot();
          setDragging(true);
        }}
        onNodeDragStop={() => setDragging(false)}
        onSelectionChange={onSelectionChange}
        nodeTypes={nodeTypes}
        fitView
        className="bg-neutral-950"
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#333" />
        <Controls className="!bg-neutral-800 !border-neutral-700 !text-neutral-300" />
        <MiniMap
          className="!bg-neutral-900 !border-neutral-700"
          nodeColor="#444"
          maskColor="rgba(0,0,0,0.5)"
        />
      </ReactFlow>
    </div>
  );
}

export function DiagramPane(props: Props) {
  return (
    <ReactFlowProvider>
      <DiagramPaneInner {...props} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: Wire DiagramPane into PaneGrid**

In `src/renderer/src/components/PaneGrid.tsx`, add the import at the top with the other pane imports:

```typescript
import { DiagramPane } from './diagram/DiagramPane';
```

Then, before the default TerminalPane branch (around line 172, before the `return (` that renders the terminal), add:

```typescript
        if (leaf.node.paneType === 'diagram') {
          return (
            <div key={leaf.id} style={rectStyle(leaf.rect)}>
              <DiagramPane paneId={leaf.id} filePath={leaf.node.filePath ?? ''} />
            </div>
          );
        }
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/diagram/DiagramPane.tsx src/renderer/src/components/PaneGrid.tsx
git commit -m "feat(diagram): add DiagramPane component wired into PaneGrid"
```

---

## Task 8: Open Diagram Files from Workspace Store and Sidebar

**Files:**
- Modify: `src/renderer/src/store/workspace-store.ts:894-916`
- Modify: `src/renderer/src/components/Sidebar.tsx:1131,1152-1162`

- [ ] **Step 1: Update openFile to detect diagram files**

In `src/renderer/src/store/workspace-store.ts`, modify the `openFile` method (around line 894). Change:

```typescript
  openFile: (filePath) => {
    const ext = getFileExt(filePath);
    const paneType = IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
    const tabType = paneType === 'image' ? 'image' : 'file';
```

to:

```typescript
  openFile: (filePath) => {
    const ext = getFileExt(filePath);
    const isDiagram = filePath.endsWith('.fleet-diagram.json');
    const paneType = isDiagram ? 'diagram' : IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
    const tabType = isDiagram ? 'diagram' : paneType === 'image' ? 'image' : 'file';
```

- [ ] **Step 2: Update openFileInTab to handle diagram type**

In `src/renderer/src/store/workspace-store.ts`, in the `openFileInTab` method (around line 947), change:

```typescript
          type: file.paneType === 'image' ? 'image' : file.paneType === 'markdown' ? 'markdown' : 'file',
```

to:

```typescript
          type: file.paneType === 'image' ? 'image' : file.paneType === 'markdown' ? 'markdown' : file.paneType === 'diagram' ? 'diagram' : 'file',
```

- [ ] **Step 3: Update Sidebar isFile check to include diagram**

In `src/renderer/src/components/Sidebar.tsx`, around line 1131, change:

```typescript
              const isFile = tab.type === 'file' || tab.type === 'image';
```

to:

```typescript
              const isFile = tab.type === 'file' || tab.type === 'image' || tab.type === 'diagram';
```

- [ ] **Step 4: Add diagram icon to Sidebar**

In `src/renderer/src/components/Sidebar.tsx`, add `Workflow` to the lucide-react imports at the top of the file (find the existing import line with `Terminal, ImageIcon`, etc. and add `Workflow`).

Then around line 1152, change the icon logic:

```typescript
              let icon: React.ReactNode;
              if (tab.type === 'pi') {
                icon = <Bot size={14} />;
              } else if (isFile) {
```

to:

```typescript
              let icon: React.ReactNode;
              if (tab.type === 'pi') {
                icon = <Bot size={14} />;
              } else if (tab.type === 'diagram') {
                icon = <Workflow size={14} />;
              } else if (isFile) {
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/workspace-store.ts src/renderer/src/components/Sidebar.tsx
git commit -m "feat(diagram): open .fleet-diagram.json as diagram pane with icon"
```

---

## Task 9: Command Palette Integration

**Files:**
- Modify: `src/renderer/src/lib/commands.ts`

- [ ] **Step 1: Add diagram commands to command registry**

In `src/renderer/src/lib/commands.ts`, add `createEmptyDiagram, serializeDiagramFile` import at the top:

```typescript
import { createEmptyDiagram, serializeDiagramFile } from '../components/diagram/types';
```

Then inside `createCommandRegistry()`, add these commands to the returned array (before the closing `];`):

```typescript
    {
      id: 'diagram-new',
      label: 'Diagram: New Blank Diagram',
      category: 'Diagram',
      execute: () => {
        const state = useWorkspaceStore.getState();
        const cwd = state.workspace.tabs.find((t) => t.id === state.activeTabId)?.cwd ?? window.fleet.homeDir;
        const dir = `${cwd}/.fleet/diagrams`;
        const fileName = `untitled-${Date.now()}.fleet-diagram.json`;
        const filePath = `${dir}/${fileName}`;
        const content = serializeDiagramFile(createEmptyDiagram('Untitled Diagram'));
        // Ensure directory exists and write file, then open
        void (async () => {
          await window.fleet.file.write(filePath, content);
          state.openFile(filePath);
        })();
      }
    },
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Manual test**

Run: `npm run dev`

1. Open the command palette (Cmd+K or your shortcut).
2. Type "Diagram" — you should see "Diagram: New Blank Diagram".
3. Execute it — a new diagram pane should open with an empty React Flow canvas (dot grid background, minimap, controls).
4. Try dragging to pan, scroll to zoom.
5. Open a `.fleet-diagram.json` file from Telescope — it should open as a diagram pane, not a text editor.
6. Check the sidebar shows a Workflow icon for diagram tabs.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/lib/commands.ts
git commit -m "feat(diagram): add new blank diagram command to command palette"
```

---

## Task 10: DiagramToolbar

**Files:**
- Create: `src/renderer/src/components/diagram/DiagramToolbar.tsx`
- Modify: `src/renderer/src/components/diagram/DiagramPane.tsx`

- [ ] **Step 1: Create the toolbar component**

Create `src/renderer/src/components/diagram/DiagramToolbar.tsx`:

```typescript
import { useCallback } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { StoreApi } from 'zustand';
import {
  Plus,
  Undo2,
  Redo2,
  Maximize,
  LayoutGrid,
  Download,
  ChevronDown,
} from 'lucide-react';
import type { DiagramState } from './use-diagram-store';
import { autoLayout, type LayoutDirection } from './layout';
import type { Node } from '@xyflow/react';

type Props = {
  store: StoreApi<DiagramState>;
  onCaptureSnapshot: () => void;
};

let nodeCounter = 0;

export function DiagramToolbar({ store, onCaptureSnapshot }: Props) {
  const { fitView } = useReactFlow();
  const state = store.getState;

  const addNode = useCallback(
    (type: string) => {
      onCaptureSnapshot();
      const id = `node-${Date.now()}-${++nodeCounter}`;
      const newNode: Node = {
        id,
        type,
        position: { x: Math.random() * 300 + 50, y: Math.random() * 300 + 50 },
        data: {
          label: type === 'markdown' ? '' : `New ${type} node`,
          ...(type === 'markdown' ? { markdown: '**New** markdown node' } : {}),
          ...(type === 'image' ? { src: '', width: 200 } : {}),
        },
      };
      store.getState().setNodes([...store.getState().nodes, newNode]);
    },
    [store, onCaptureSnapshot]
  );

  const handleAutoLayout = useCallback(
    (direction: LayoutDirection) => {
      onCaptureSnapshot();
      const { nodes, edges } = store.getState();
      const laid = autoLayout(nodes, edges, direction);
      store.getState().setNodes(laid);
      setTimeout(() => fitView({ duration: 300 }), 50);
    },
    [store, onCaptureSnapshot, fitView]
  );

  const handleUndo = useCallback(() => store.getState().undo(), [store]);
  const handleRedo = useCallback(() => store.getState().redo(), [store]);

  const btnClass =
    'flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700 transition-colors';

  return (
    <div className="flex items-center gap-1 border-b border-neutral-800 bg-neutral-900 px-2 py-1">
      {/* Add node dropdown */}
      <div className="group relative">
        <button className={btnClass}>
          <Plus size={14} /> Add <ChevronDown size={10} />
        </button>
        <div className="absolute left-0 top-full z-50 hidden min-w-[140px] rounded border border-neutral-700 bg-neutral-800 py-1 shadow-lg group-hover:block">
          <button className={`${btnClass} w-full`} onClick={() => addNode('default')}>
            Default Node
          </button>
          <button className={`${btnClass} w-full`} onClick={() => addNode('group')}>
            Group
          </button>
          <button className={`${btnClass} w-full`} onClick={() => addNode('markdown')}>
            Markdown Node
          </button>
          <button className={`${btnClass} w-full`} onClick={() => addNode('image')}>
            Image Node
          </button>
          <button className={`${btnClass} w-full`} onClick={() => addNode('input')}>
            Input Node
          </button>
          <button className={`${btnClass} w-full`} onClick={() => addNode('output')}>
            Output Node
          </button>
        </div>
      </div>

      <div className="mx-1 h-4 w-px bg-neutral-700" />

      {/* Undo/Redo */}
      <button className={btnClass} onClick={handleUndo} title="Undo (Cmd+Z)">
        <Undo2 size={14} />
      </button>
      <button className={btnClass} onClick={handleRedo} title="Redo (Cmd+Shift+Z)">
        <Redo2 size={14} />
      </button>

      <div className="mx-1 h-4 w-px bg-neutral-700" />

      {/* Layout */}
      <button className={btnClass} onClick={() => handleAutoLayout('TB')} title="Auto-layout (top-down)">
        <LayoutGrid size={14} /> Layout ↓
      </button>
      <button className={btnClass} onClick={() => handleAutoLayout('LR')} title="Auto-layout (left-right)">
        <LayoutGrid size={14} /> Layout →
      </button>

      {/* Fit view */}
      <button className={btnClass} onClick={() => fitView({ duration: 300 })} title="Fit view">
        <Maximize size={14} />
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire toolbar into DiagramPane**

In `src/renderer/src/components/diagram/DiagramPane.tsx`, add the import:

```typescript
import { DiagramToolbar } from './DiagramToolbar';
```

Then in the `DiagramPaneInner` component, wrap the `ReactFlow` in a flex column and add the toolbar before it. Replace the return JSX (the one with `<div className="h-full w-full">`):

```typescript
  return (
    <div className="flex h-full w-full flex-col" data-pane-id={paneId}>
      <DiagramToolbar store={store} onCaptureSnapshot={captureSnapshot} />
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          defaultViewport={viewport}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={(_event, vp) => setViewport(vp)}
          onNodeDragStart={() => {
            captureSnapshot();
            setDragging(true);
          }}
          onNodeDragStop={() => setDragging(false)}
          onSelectionChange={onSelectionChange}
          nodeTypes={nodeTypes}
          fitView
          className="bg-neutral-950"
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#333" />
          <Controls className="!bg-neutral-800 !border-neutral-700 !text-neutral-300" />
          <MiniMap
            className="!bg-neutral-900 !border-neutral-700"
            nodeColor="#444"
            maskColor="rgba(0,0,0,0.5)"
          />
        </ReactFlow>
      </div>
    </div>
  );
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual test**

Run: `npm run dev`

1. Create a new blank diagram via command palette.
2. Click "Add" → "Default Node" — a node should appear on the canvas.
3. Add another node and connect them by dragging from one handle to another.
4. Click "Layout ↓" — nodes should reposition in a top-down hierarchy.
5. Move a node, then click Undo — it should snap back. Click Redo — it moves again.
6. Click "Fit view" — canvas should zoom to fit all nodes.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/diagram/DiagramToolbar.tsx src/renderer/src/components/diagram/DiagramPane.tsx
git commit -m "feat(diagram): add toolbar with add node, undo/redo, layout, fit view"
```

---

## Task 11: Properties Panel

**Files:**
- Create: `src/renderer/src/components/diagram/PropertiesPanel.tsx`
- Modify: `src/renderer/src/components/diagram/DiagramPane.tsx`

- [ ] **Step 1: Create the properties panel**

Create `src/renderer/src/components/diagram/PropertiesPanel.tsx`:

```typescript
import { useState, useCallback } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand';
import { PanelRight, X } from 'lucide-react';
import type { DiagramState } from './use-diagram-store';
import type { Node, Edge } from '@xyflow/react';

type Props = {
  store: StoreApi<DiagramState>;
  onCaptureSnapshot: () => void;
};

export function PropertiesPanel({ store, onCaptureSnapshot }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const selectedNodeIds = useStore(store, (s) => s.selectedNodeIds);
  const selectedEdgeIds = useStore(store, (s) => s.selectedEdgeIds);

  const selectedNode = nodes.find((n) => selectedNodeIds.has(n.id));
  const selectedEdge = edges.find((e) => selectedEdgeIds.has(e.id));

  const updateNode = useCallback(
    (id: string, updater: (node: Node) => Node) => {
      onCaptureSnapshot();
      const updated = store.getState().nodes.map((n) => (n.id === id ? updater(n) : n));
      store.getState().setNodes(updated);
    },
    [store, onCaptureSnapshot]
  );

  const updateEdge = useCallback(
    (id: string, updater: (edge: Edge) => Edge) => {
      onCaptureSnapshot();
      const updated = store.getState().edges.map((e) => (e.id === id ? updater(e) : e));
      store.getState().setEdges(updated);
    },
    [store, onCaptureSnapshot]
  );

  if (collapsed) {
    if (!selectedNode && !selectedEdge) return null;
    return (
      <button
        className="absolute right-2 top-12 z-10 rounded bg-neutral-800 p-1.5 text-neutral-400 hover:bg-neutral-700"
        onClick={() => setCollapsed(false)}
        title="Open properties"
      >
        <PanelRight size={16} />
      </button>
    );
  }

  const inputClass = 'w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200';
  const labelClass = 'text-xs text-neutral-500 mb-1';

  return (
    <div className="absolute right-0 top-10 z-10 flex h-[calc(100%-2.5rem)] w-60 flex-col border-l border-neutral-800 bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-xs font-semibold text-neutral-300">Properties</span>
        <button className="text-neutral-500 hover:text-neutral-300" onClick={() => setCollapsed(true)}>
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {selectedNode && (
          <>
            <div>
              <div className={labelClass}>Label</div>
              <input
                className={inputClass}
                value={(selectedNode.data as Record<string, unknown>).label as string ?? ''}
                onChange={(e) =>
                  updateNode(selectedNode.id, (n) => ({
                    ...n,
                    data: { ...n.data, label: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <div className={labelClass}>Background</div>
              <input
                type="color"
                className="h-8 w-full cursor-pointer rounded border border-neutral-700"
                value={(selectedNode.style?.background as string) ?? '#1e293b'}
                onChange={(e) =>
                  updateNode(selectedNode.id, (n) => ({
                    ...n,
                    style: { ...n.style, background: e.target.value },
                  }))
                }
              />
            </div>
            <div>
              <div className={labelClass}>Border Color</div>
              <input
                type="color"
                className="h-8 w-full cursor-pointer rounded border border-neutral-700"
                value={(selectedNode.style?.borderColor as string) ?? '#334155'}
                onChange={(e) =>
                  updateNode(selectedNode.id, (n) => ({
                    ...n,
                    style: { ...n.style, borderColor: e.target.value, border: `1px solid ${e.target.value}` },
                  }))
                }
              />
            </div>
            {selectedNode.type === 'markdown' && (
              <div>
                <div className={labelClass}>Markdown</div>
                <textarea
                  className={`${inputClass} h-24 resize-y font-mono`}
                  value={(selectedNode.data as Record<string, unknown>).markdown as string ?? ''}
                  onChange={(e) =>
                    updateNode(selectedNode.id, (n) => ({
                      ...n,
                      data: { ...n.data, markdown: e.target.value },
                    }))
                  }
                />
              </div>
            )}
            {selectedNode.type === 'image' && (
              <div>
                <div className={labelClass}>Image Path</div>
                <input
                  className={inputClass}
                  value={(selectedNode.data as Record<string, unknown>).src as string ?? ''}
                  onChange={(e) =>
                    updateNode(selectedNode.id, (n) => ({
                      ...n,
                      data: { ...n.data, src: e.target.value },
                    }))
                  }
                />
              </div>
            )}
          </>
        )}

        {selectedEdge && (
          <>
            <div>
              <div className={labelClass}>Edge Label</div>
              <input
                className={inputClass}
                value={selectedEdge.label as string ?? ''}
                onChange={(e) => updateEdge(selectedEdge.id, (edge) => ({ ...edge, label: e.target.value }))}
              />
            </div>
            <div>
              <div className={labelClass}>Edge Type</div>
              <select
                className={inputClass}
                value={selectedEdge.type ?? 'default'}
                onChange={(e) => updateEdge(selectedEdge.id, (edge) => ({ ...edge, type: e.target.value }))}
              >
                <option value="default">Default (Bezier)</option>
                <option value="straight">Straight</option>
                <option value="smoothstep">Smooth Step</option>
                <option value="step">Step</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selectedEdge.animated ?? false}
                onChange={(e) =>
                  updateEdge(selectedEdge.id, (edge) => ({ ...edge, animated: e.target.checked }))
                }
              />
              <span className="text-xs text-neutral-400">Animated</span>
            </div>
          </>
        )}

        {!selectedNode && !selectedEdge && (
          <div className="text-xs text-neutral-500 pt-4 text-center">
            Select a node or edge to edit its properties.
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire PropertiesPanel into DiagramPane**

In `src/renderer/src/components/diagram/DiagramPane.tsx`, add the import:

```typescript
import { PropertiesPanel } from './PropertiesPanel';
```

Then add the panel inside the flex container, after the `<DiagramToolbar>` and before the `<div className="flex-1 min-h-0">`. The container div should become `relative`:

Change:
```typescript
    <div className="flex h-full w-full flex-col" data-pane-id={paneId}>
      <DiagramToolbar store={store} onCaptureSnapshot={captureSnapshot} />
      <div className="flex-1 min-h-0">
```

to:
```typescript
    <div className="flex h-full w-full flex-col" data-pane-id={paneId}>
      <DiagramToolbar store={store} onCaptureSnapshot={captureSnapshot} />
      <div className="relative flex-1 min-h-0">
        <PropertiesPanel store={store} onCaptureSnapshot={captureSnapshot} />
```

And close the extra div by adding `</div>` before the outer closing `</div>`. The ReactFlow and its children stay inside this `<div className="relative flex-1 min-h-0">`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual test**

Run: `npm run dev`

1. Open a diagram, add a few nodes and connect them.
2. Click a node — a small panel icon should appear on the right. Click it.
3. Edit the label — node should update live.
4. Change background color — node color should change.
5. Click an edge — edge properties should appear (label, type, animated).
6. Change edge type to "Smooth Step" — edge rendering should change.
7. Close the panel with X. Select nothing — panel icon should disappear.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/diagram/PropertiesPanel.tsx src/renderer/src/components/diagram/DiagramPane.tsx
git commit -m "feat(diagram): add properties panel for node/edge editing"
```

---

## Task 12: Context Menu and Copy/Paste

**Files:**
- Create: `src/renderer/src/components/diagram/NodeContextMenu.tsx`
- Modify: `src/renderer/src/components/diagram/DiagramPane.tsx`

- [ ] **Step 1: Create the context menu**

Create `src/renderer/src/components/diagram/NodeContextMenu.tsx`:

```typescript
import { useCallback, useState, useEffect, useRef } from 'react';
import type { StoreApi } from 'zustand';
import type { DiagramState } from './use-diagram-store';
import type { Node, Edge } from '@xyflow/react';

type MenuPosition = { x: number; y: number } | null;

type Props = {
  store: StoreApi<DiagramState>;
  onCaptureSnapshot: () => void;
};

// Module-level clipboard for cross-pane paste
let clipboard: { nodes: Node[]; edges: Edge[] } | null = null;

export function useContextMenu(store: StoreApi<DiagramState>, onCaptureSnapshot: () => void) {
  const [menuPos, setMenuPos] = useState<MenuPosition>(null);

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      setMenuPos({ x: event.clientX, y: event.clientY });
    },
    []
  );

  const close = useCallback(() => setMenuPos(null), []);

  const deleteSelected = useCallback(() => {
    onCaptureSnapshot();
    const state = store.getState();
    const newNodes = state.nodes.filter((n) => !state.selectedNodeIds.has(n.id));
    const removedIds = new Set(state.nodes.filter((n) => state.selectedNodeIds.has(n.id)).map((n) => n.id));
    const newEdges = state.edges.filter(
      (e) => !state.selectedEdgeIds.has(e.id) && !removedIds.has(e.source) && !removedIds.has(e.target)
    );
    state.setNodes(newNodes);
    state.setEdges(newEdges);
    close();
  }, [store, onCaptureSnapshot, close]);

  const copySelected = useCallback(() => {
    const state = store.getState();
    const selectedNodes = state.nodes.filter((n) => state.selectedNodeIds.has(n.id));
    const selectedNodeIds = new Set(selectedNodes.map((n) => n.id));
    const connectedEdges = state.edges.filter(
      (e) => selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target)
    );
    clipboard = { nodes: selectedNodes, edges: connectedEdges };
    close();
  }, [store, close]);

  const paste = useCallback(() => {
    if (!clipboard) return;
    onCaptureSnapshot();
    const state = store.getState();
    const idMap = new Map<string, string>();
    const offset = 20;

    const newNodes = clipboard.nodes.map((n) => {
      const newId = `${n.id}-copy-${Date.now()}`;
      idMap.set(n.id, newId);
      return {
        ...n,
        id: newId,
        position: { x: n.position.x + offset, y: n.position.y + offset },
        selected: false,
      };
    });

    const newEdges = clipboard.edges.map((e) => ({
      ...e,
      id: `${e.id}-copy-${Date.now()}`,
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
      selected: false,
    }));

    state.setNodes([...state.nodes, ...newNodes]);
    state.setEdges([...state.edges, ...newEdges]);
    close();
  }, [store, onCaptureSnapshot, close]);

  // Keyboard shortcuts for copy/paste/delete
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === 'c') {
        copySelected();
      } else if (isMod && e.key === 'v') {
        paste();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        // Only delete if not in an input field
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return;
        onCaptureSnapshot();
        const state = store.getState();
        if (state.selectedNodeIds.size > 0 || state.selectedEdgeIds.size > 0) {
          deleteSelected();
        }
      } else if (isMod && e.key === 'a') {
        e.preventDefault();
        const state = store.getState();
        state.setSelection(
          state.nodes.map((n) => n.id),
          state.edges.map((e) => e.id)
        );
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [store, copySelected, paste, deleteSelected, onCaptureSnapshot]);

  return { menuPos, onContextMenu, close, deleteSelected, copySelected, paste };
}

export function NodeContextMenu({
  menuPos,
  onClose,
  onDelete,
  onCopy,
  onPaste,
}: {
  menuPos: { x: number; y: number };
  onClose: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onPaste: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const itemClass =
    'block w-full px-3 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-700';

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[140px] rounded border border-neutral-700 bg-neutral-800 py-1 shadow-lg"
      style={{ left: menuPos.x, top: menuPos.y }}
    >
      <button className={itemClass} onClick={onCopy}>
        Copy
      </button>
      <button className={itemClass} onClick={onPaste}>
        Paste
      </button>
      <div className="my-1 h-px bg-neutral-700" />
      <button className={`${itemClass} text-red-400 hover:text-red-300`} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire context menu into DiagramPane**

In `src/renderer/src/components/diagram/DiagramPane.tsx`, add imports:

```typescript
import { useContextMenu, NodeContextMenu } from './NodeContextMenu';
```

Inside `DiagramPaneInner`, after the `useDiagramSync` call, add:

```typescript
  const { menuPos, onContextMenu, close, deleteSelected, copySelected, paste } = useContextMenu(
    store,
    captureSnapshot
  );
```

Add `onContextMenu={onContextMenu}` to the `<ReactFlow>` component props.

After the `</ReactFlow>` closing tag (but inside the `<div className="relative flex-1 min-h-0">`), add:

```typescript
        {menuPos && (
          <NodeContextMenu
            menuPos={menuPos}
            onClose={close}
            onDelete={deleteSelected}
            onCopy={copySelected}
            onPaste={paste}
          />
        )}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Manual test**

Run: `npm run dev`

1. Add a few nodes and connect them.
2. Select a node, press `Cmd+C`, then `Cmd+V` — a copy should appear offset by 20px.
3. Select a node, press `Delete` — it should be removed along with its connected edges.
4. Right-click on the canvas — context menu should appear with Copy/Paste/Delete.
5. `Cmd+A` should select all nodes and edges.
6. Test undo after delete — nodes should come back.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/diagram/NodeContextMenu.tsx src/renderer/src/components/diagram/DiagramPane.tsx
git commit -m "feat(diagram): add context menu with copy/paste/delete and keyboard shortcuts"
```

---

## Task 13: Export (PNG/SVG)

**Files:**
- Create: `src/renderer/src/components/diagram/export.ts`
- Modify: `src/renderer/src/components/diagram/DiagramToolbar.tsx`

- [ ] **Step 1: Create export helpers**

Create `src/renderer/src/components/diagram/export.ts`:

```typescript
import { toSvg, toPng } from '@xyflow/react';

export async function exportDiagramPng(element: HTMLElement): Promise<void> {
  const dataUrl = await toPng(element, {
    backgroundColor: '#0a0a0a',
  });
  const link = document.createElement('a');
  link.download = 'diagram.png';
  link.href = dataUrl;
  link.click();
}

export async function exportDiagramSvg(element: HTMLElement): Promise<void> {
  const dataUrl = await toSvg(element, {
    backgroundColor: '#0a0a0a',
  });
  const link = document.createElement('a');
  link.download = 'diagram.svg';
  link.href = dataUrl;
  link.click();
}
```

- [ ] **Step 2: Add export buttons to toolbar**

In `src/renderer/src/components/diagram/DiagramToolbar.tsx`, add the import:

```typescript
import { exportDiagramPng, exportDiagramSvg } from './export';
```

Add export callbacks inside the component:

```typescript
  const handleExportPng = useCallback(() => {
    const el = document.querySelector('.react-flow') as HTMLElement | null;
    if (el) void exportDiagramPng(el);
  }, []);

  const handleExportSvg = useCallback(() => {
    const el = document.querySelector('.react-flow') as HTMLElement | null;
    if (el) void exportDiagramSvg(el);
  }, []);
```

Add export buttons to the toolbar JSX, after the fit view button:

```typescript
      <div className="mx-1 h-4 w-px bg-neutral-700" />

      {/* Export */}
      <div className="group relative">
        <button className={btnClass}>
          <Download size={14} /> Export <ChevronDown size={10} />
        </button>
        <div className="absolute left-0 top-full z-50 hidden min-w-[120px] rounded border border-neutral-700 bg-neutral-800 py-1 shadow-lg group-hover:block">
          <button className={`${btnClass} w-full`} onClick={handleExportPng}>
            PNG
          </button>
          <button className={`${btnClass} w-full`} onClick={handleExportSvg}>
            SVG
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. (Note: `toSvg` and `toPng` may need to be imported from `@xyflow/react` — verify they exist in the installed version. If not, they may be in a separate `@xyflow/react` subpath or require `html-to-image` as a peer dependency. Adjust imports accordingly.)

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/diagram/export.ts src/renderer/src/components/diagram/DiagramToolbar.tsx
git commit -m "feat(diagram): add PNG and SVG export"
```

---

## Task 14: Static Codebase Analyzers (Dependency Graph + Directory Structure)

**Files:**
- Create: `src/main/diagram-analyzer.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Create the analyzer module**

Create `src/main/diagram-analyzer.ts`:

```typescript
import { readFile, readdir, stat } from 'fs/promises';
import { join, relative, extname, dirname } from 'path';
import dagre from '@dagrejs/dagre';
import type { Node, Edge } from '@xyflow/react';

type FleetDiagramFile = {
  version: 1;
  meta: { title: string; createdBy: string; createdAt: string };
  nodes: Node[];
  edges: Edge[];
  viewport: { x: 0; y: 0; zoom: 1 };
};

const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IMPORT_RE = /(?:import\s+.*?from\s+['"](.+?)['"]|require\s*\(\s*['"](.+?)['"]\s*\))/g;

async function walkFiles(dir: string, ignoredDirs: Set<string>): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath, ignoredDirs)));
    } else if (JS_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function resolveImport(from: string, importPath: string, allFiles: Set<string>): string | null {
  if (importPath.startsWith('.')) {
    const dir = dirname(from);
    const base = join(dir, importPath);
    // Try exact match, then with extensions
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      if (allFiles.has(base + ext)) return base + ext;
    }
  }
  return null; // External dependency, skip
}

export async function analyzeDependencies(rootDir: string): Promise<FleetDiagramFile> {
  const ignoredDirs = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage']);
  const files = await walkFiles(rootDir, ignoredDirs);
  const fileSet = new Set(files);

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const nodeIds = new Map<string, string>();

  // Create nodes
  for (const file of files) {
    const id = `dep-${nodes.length}`;
    const relPath = relative(rootDir, file);
    nodeIds.set(file, id);
    nodes.push({
      id,
      type: 'default',
      position: { x: 0, y: 0 },
      data: { label: relPath },
      style: { background: '#1e293b', border: '1px solid #334155', fontSize: '10px' },
    });
  }

  // Parse imports and create edges
  for (const file of files) {
    const content = await readFile(file, 'utf-8');
    let match: RegExpExecArray | null;
    IMPORT_RE.lastIndex = 0;
    while ((match = IMPORT_RE.exec(content))) {
      const importPath = match[1] ?? match[2];
      const resolved = resolveImport(file, importPath, fileSet);
      if (resolved) {
        const sourceId = nodeIds.get(file)!;
        const targetId = nodeIds.get(resolved)!;
        edges.push({
          id: `e-${sourceId}-${targetId}`,
          source: sourceId,
          target: targetId,
          type: 'smoothstep',
        });
      }
    }
  }

  // Auto-layout with dagre
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 60 });
  for (const node of nodes) g.setNode(node.id, { width: 180, height: 30 });
  for (const edge of edges) g.setEdge(edge.source, edge.target);
  dagre.layout(g);
  for (const node of nodes) {
    const pos = g.node(node.id);
    if (pos) node.position = { x: pos.x - 90, y: pos.y - 15 };
  }

  return {
    version: 1,
    meta: { title: 'Dependency Graph', createdBy: 'fleet-analyzer', createdAt: new Date().toISOString() },
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

export async function analyzeDirectoryStructure(rootDir: string): Promise<FleetDiagramFile> {
  const ignoredDirs = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage']);
  const nodes: Node[] = [];
  const nodeIds = new Map<string, string>();
  let counter = 0;

  async function walk(dir: string, parentId?: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    let childIndex = 0;
    for (const entry of sorted) {
      if (entry.name.startsWith('.') || ignoredDirs.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      const id = `dir-${counter++}`;
      nodeIds.set(fullPath, id);

      const node: Node = {
        id,
        type: entry.isDirectory() ? 'group' : 'default',
        position: { x: childIndex * 40, y: childIndex * 40 },
        data: { label: entry.name },
        style: entry.isDirectory()
          ? { background: 'rgba(30,41,59,0.3)', border: '2px dashed #334155', padding: 30, minWidth: 200, minHeight: 80 }
          : { background: '#1e293b', border: '1px solid #334155', fontSize: '11px' },
        ...(parentId ? { parentId, extent: 'parent' as const } : {}),
      };
      nodes.push(node);

      if (entry.isDirectory()) {
        await walk(fullPath, id);
      }
      childIndex++;
    }
  }

  await walk(rootDir);

  return {
    version: 1,
    meta: { title: 'Directory Structure', createdBy: 'fleet-analyzer', createdAt: new Date().toISOString() },
    nodes,
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
```

- [ ] **Step 2: Add analyzer IPC channels**

The channels `DIAGRAM_ANALYZE_DEPS` and `DIAGRAM_ANALYZE_DIRS` were already added in Task 2. Verify they exist in `src/shared/ipc-channels.ts`.

- [ ] **Step 3: Register analyzer IPC handlers**

In `src/main/ipc-handlers.ts`, add the import:

```typescript
import { analyzeDependencies, analyzeDirectoryStructure } from './diagram-analyzer';
```

Add handlers after the existing diagram handlers:

```typescript
  ipcMain.handle(IPC_CHANNELS.DIAGRAM_ANALYZE_DEPS, async (_event, rootDir: string) => {
    try {
      const diagram = await analyzeDependencies(rootDir);
      return { success: true, data: diagram };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DIAGRAM_ANALYZE_DIRS, async (_event, rootDir: string) => {
    try {
      const diagram = await analyzeDirectoryStructure(rootDir);
      return { success: true, data: diagram };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
```

- [ ] **Step 4: Expose in preload**

In `src/preload/index.ts`, add to the `diagram` namespace:

```typescript
    analyzeDeps: async (rootDir: string): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      typedInvoke(IPC_CHANNELS.DIAGRAM_ANALYZE_DEPS, rootDir),
    analyzeDirs: async (rootDir: string): Promise<{ success: boolean; data?: unknown; error?: string }> =>
      typedInvoke(IPC_CHANNELS.DIAGRAM_ANALYZE_DIRS, rootDir),
```

- [ ] **Step 5: Add analyzer commands to command palette**

In `src/renderer/src/lib/commands.ts`, add these commands inside `createCommandRegistry()`:

```typescript
    {
      id: 'diagram-deps',
      label: 'Diagram: Dependency Graph',
      category: 'Diagram',
      execute: () => {
        const state = useWorkspaceStore.getState();
        const cwd = state.workspace.tabs.find((t) => t.id === state.activeTabId)?.cwd ?? window.fleet.homeDir;
        void (async () => {
          const result = await window.fleet.diagram.analyzeDeps(cwd);
          if (result.success && result.data) {
            const dir = `${cwd}/.fleet/diagrams`;
            const filePath = `${dir}/dependency-graph.fleet-diagram.json`;
            await window.fleet.file.write(filePath, JSON.stringify(result.data, null, 2));
            state.openFile(filePath);
          }
        })();
      }
    },
    {
      id: 'diagram-dirs',
      label: 'Diagram: Directory Structure',
      category: 'Diagram',
      execute: () => {
        const state = useWorkspaceStore.getState();
        const cwd = state.workspace.tabs.find((t) => t.id === state.activeTabId)?.cwd ?? window.fleet.homeDir;
        void (async () => {
          const result = await window.fleet.diagram.analyzeDirs(cwd);
          if (result.success && result.data) {
            const dir = `${cwd}/.fleet/diagrams`;
            const filePath = `${dir}/directory-structure.fleet-diagram.json`;
            await window.fleet.file.write(filePath, JSON.stringify(result.data, null, 2));
            state.openFile(filePath);
          }
        })();
      }
    },
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Manual test**

Run: `npm run dev`

1. Open command palette, run "Diagram: Dependency Graph".
2. A diagram pane should open showing the import graph of the current workspace. Nodes should be labeled with relative file paths and laid out hierarchically.
3. Run "Diagram: Directory Structure" — a nested group diagram should appear with folders containing file nodes.

- [ ] **Step 8: Commit**

```bash
git add src/main/diagram-analyzer.ts src/main/ipc-handlers.ts src/preload/index.ts src/renderer/src/lib/commands.ts
git commit -m "feat(diagram): add static codebase analyzers (dependency graph + directory structure)"
```

---

## Task 15: Final Integration Test and Cleanup

**Files:**
- No new files.

- [ ] **Step 1: Run full typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS (or only pre-existing warnings). Fix any new lint errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS — the app builds successfully with the new diagram feature.

- [ ] **Step 4: Full manual smoke test**

Run: `npm run dev`

Test the complete feature flow:
1. **New blank diagram:** Command palette → "Diagram: New Blank Diagram" → empty canvas opens with toolbar.
2. **Add nodes:** Use toolbar to add default, markdown, and group nodes. Connect them with edges.
3. **Edit properties:** Click a node → properties panel opens → change label, colors. Click edge → change type.
4. **Undo/Redo:** Make changes, Cmd+Z to undo, Cmd+Shift+Z to redo.
5. **Copy/Paste:** Select nodes, Cmd+C, Cmd+V. Verify copies appear offset.
6. **Delete:** Select nodes, press Delete. Verify connected edges also removed.
7. **Auto-layout:** Click Layout ↓ and Layout →. Nodes should reposition.
8. **Export:** Export → PNG and SVG. Verify files download.
9. **File sync:** Open the diagram's JSON file in a text editor (right-click tab → "Open as JSON" if implemented, or use a terminal `cat`). Edit the JSON externally → diagram should update live.
10. **Dependency graph:** Command palette → "Diagram: Dependency Graph" → should render a graph of the project's imports.
11. **Directory structure:** Command palette → "Diagram: Directory Structure" → should render nested folder groups.
12. **Sidebar icon:** Diagram tabs should show the Workflow icon.
13. **Workspace persistence:** Close and reopen the workspace — diagram panes should restore.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix(diagram): address integration test findings"
```

Only commit this if there were actual fixes needed. Skip if everything passed clean.
