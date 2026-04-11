# Diagram Pane — Design Spec

**Date:** 2026-04-11
**Status:** Draft

## Overview

A React Flow-based diagram pane for Fleet that enables both humans and AI agents to create, view, and edit architecture diagrams and charts. Diagrams are stored as JSON files on disk, with live two-way sync between the visual editor and the file. Fleet also provides codebase analysis commands that auto-generate diagrams via static analysis and AI.

## File Format

**Extension:** `.fleet-diagram.json`

Fleet recognizes any `.fleet-diagram.json` file as a diagram. The format is React Flow's native node/edge structure wrapped in a thin Fleet metadata envelope:

```json
{
  "version": 1,
  "meta": {
    "title": "Auth System Architecture",
    "createdBy": "fleet-analyzer",
    "createdAt": "2026-04-11T10:00:00Z"
  },
  "nodes": [
    {
      "id": "1",
      "type": "default",
      "position": { "x": 100, "y": 200 },
      "data": { "label": "API Gateway" },
      "style": { "background": "#1e293b", "border": "1px solid #334155" }
    }
  ],
  "edges": [
    {
      "id": "e1-2",
      "source": "1",
      "target": "2",
      "label": "REST",
      "type": "smoothstep",
      "animated": true
    }
  ],
  "viewport": { "x": 0, "y": 0, "zoom": 1 }
}
```

**Supported node types:**

| Type | Description |
|------|-------------|
| `default` | Standard labeled box |
| `group` | Container that parents other nodes (via `parentId` + `extent: "parent"`) |
| `markdown` | Renders markdown content inside the node |
| `image` | Displays an image (local path or URL) |
| `input` / `output` | Entry/exit point markers |

The `meta` envelope is Fleet-specific (title, provenance). Everything inside `nodes`, `edges`, `viewport` is pure React Flow — agents can generate it using React Flow docs directly.

## Diagram Pane & Rich Editing UI

### Pane Integration

- New `paneType: 'diagram'` added to `PaneLeaf` in the type system.
- `PaneGrid` renders a `DiagramPane` component when it encounters this type.
- Opening a `.fleet-diagram.json` file (via sidebar, quick-open, or command palette) opens it as a diagram pane instead of a text editor.
- Diagrams participate in the split layout — terminal on the left, diagram on the right, side by side.

### Component Structure

```
DiagramPane
├── DiagramToolbar          — top bar: add node, undo/redo, zoom controls, fit view, export
├── ReactFlowProvider
│   └── ReactFlow           — the canvas
│       ├── MiniMap
│       ├── Controls
│       └── Background       — dot grid
├── PropertiesPanel         — right sidebar (collapsible): edit selected node/edge properties
└── NodeContextMenu         — right-click menu on nodes/edges/canvas
```

### Toolbar Actions

- Add node (dropdown: default, group, markdown, image)
- Add edge mode (click source → click target)
- Undo / Redo (command history stack)
- Copy / Paste / Delete selected
- Fit view / Zoom to selection
- Auto-layout (re-run dagre layout)
- Export as PNG/SVG

### Properties Panel

Appears when a node or edge is selected:

- **Node:** label, type, colors (bg/border/text), size, parent group assignment
- **Edge:** label, type (straight/smoothstep/bezier), color, animated toggle, arrow style
- **Markdown node:** inline markdown editor
- **Image node:** file path picker

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Z` / `Cmd+Shift+Z` | Undo / Redo |
| `Cmd+C` / `Cmd+V` | Copy / Paste nodes |
| `Delete` / `Backspace` | Remove selected |
| `Cmd+A` | Select all |
| `Cmd+Shift+L` | Auto-layout |

### Theming

Matches Fleet's dark theme. Node defaults: neutral-800 bg, neutral-600 borders, neutral-200 text. Selection highlights in teal (Fleet's accent color). Canvas uses a subtle dot grid on the base dark background.

## Two-Way Sync & File Watching

### Architecture

```
┌─────────────┐     write-back      ┌──────────────┐
│ DiagramPane  │ ──────────────────► │  .json file  │
│ (renderer)   │                     │  (on disk)    │
│              │ ◄────────────────── │              │
└─────────────┘    file watcher      └──────────────┘
       │                                    ▲
       │ IPC: diagram:save                  │
       ▼                                    │
┌─────────────┐                             │
│ Main process │ ───── fs.writeFile ────────┘
│ file-watcher │ ───── fs.watch ────────────┐
│              │                             │
└─────────────┘    IPC: diagram:file-changed │
       │                                     │
       └─────────────────────────────────────┘
```

### Visual → File (Write-Back)

- React Flow's `onNodesChange` / `onEdgesChange` / `onViewportChange` fire on every visual edit.
- Changes are debounced (300ms) and sent to main process via IPC `diagram:save`.
- Main process writes the file atomically (write to temp file, rename).
- A `writeId` token tags each write so the file watcher can ignore self-triggered changes.

### File → Visual (File Watching)

- Main process watches the `.fleet-diagram.json` file with `fs.watch`.
- On external change (writeId doesn't match), main reads the file and sends `diagram:file-changed` to the renderer.
- DiagramPane diffs incoming nodes/edges against current state.
- Positions and properties update smoothly; new nodes appear, deleted nodes disappear.
- If the user is mid-drag (mouse down), incoming updates queue until the interaction finishes.

### Conflict Avoidance

- The `writeId` mechanism prevents echo loops (pane writes → watcher fires → pane ignores its own write).
- Simultaneous edits from user and agent use last-write-wins at the file level, but the pane merges non-conflicting changes (e.g., agent adds a node while user edits a label on a different node).
- No merge UI needed — the real-time nature means conflicts are rare and small.

### Dirty State

- The pane tracks an `isDirty` flag like the file editor does.
- On close with unsaved changes, Fleet prompts to save (same pattern as file editor panes).

## Codebase Analyzer

Two analysis modes triggered from Fleet commands.

### Static Analysis

Runs in the main process. Produces deterministic, structural diagrams.

**Dependency graph analyzer:**
- Parses JS/TS files using a lightweight regex-based import scanner (not a full AST). Scans `import`/`require` statements to build a module dependency graph.
- v1 supports JS/TS only. Other languages (Python, Go, Rust) can be added later via pattern matchers.
- Outputs a `.fleet-diagram.json` with one node per module and edges for imports.
- Uses dagre for auto-layout (hierarchical top-down).

**Directory structure analyzer:**
- Walks the file tree (respecting `.gitignore`) and generates a nested group diagram — folders are group nodes, files are leaf nodes inside them.

### AI-Powered Analysis

1. Fleet gathers context: file tree, key files (package.json, entry points, config), and optionally file contents (up to a token budget).
2. Sends a prompt to a running agent session via Fleet's copilot socket. Fleet looks for an active copilot session in the current workspace; if none exists, it spawns a new agent session to handle the request.
3. The prompt includes the React Flow JSON schema and node type options so the model outputs valid diagram JSON.
4. Fleet validates the response, writes it to a `.fleet-diagram.json`, and opens it in a diagram pane.

### Commands (Command Palette)

| Command | Type | Description |
|---------|------|-------------|
| `Diagram: Dependency Graph` | Static | Import/require dependency graph of current workspace |
| `Diagram: Directory Structure` | Static | Nested folder/file visual map |
| `Diagram: Architecture (AI)` | AI | High-level system architecture diagram |
| `Diagram: New Blank Diagram` | — | Creates an empty diagram and opens it |

### Output Location

Diagrams are written to `.fleet/diagrams/` in the workspace root. The user can also save-as to any location.

## State Management & Undo/Redo

### Zustand Store (Per Pane)

Each open diagram pane gets its own Zustand store instance (not a global singleton), following Fleet's existing per-pane state pattern.

```
DiagramStore
├── nodes: Node[]
├── edges: Edge[]
├── viewport: Viewport
├── selectedElements: string[]
├── history: { past: Snapshot[], future: Snapshot[] }
├── isDirty: boolean
├── filePath: string
├── writeId: string | null
```

### Undo/Redo

- Snapshot-based history stack. Before each meaningful action (add/delete/move node on drag-end, edit label, style change), a snapshot of `{ nodes, edges }` is pushed to `past[]`.
- Undo pops from `past`, pushes current to `future`. Redo does the reverse.
- Intermediate drag events (mouse-move during drag) are not recorded — only the final position on mouse-up.
- History capped at 100 entries.
- A new action after an undo clears the `future` stack.

### Copy/Paste

- Copy serializes selected nodes + their connecting edges to an internal clipboard (in-memory, not system clipboard).
- Paste deserializes with new IDs and offsets positions by +20px to avoid stacking.
- Cross-pane paste works between two open diagram panes (shared in-memory clipboard scoped to the renderer process).

### React Flow Integration

- The store provides `onNodesChange`, `onEdgesChange`, `onConnect` callbacks wired into React Flow's controlled mode.
- These callbacks update the store, which triggers the debounced write-back to disk.

## Auto-Layout, Export & Fleet Integration

### Auto-Layout

- Uses dagre for automatic node positioning.
- Runs automatically when opening a diagram with nodes that have no positions (all at 0,0), or on user click of "Auto-layout."
- Layout directions: top-down (default for dependency graphs), left-to-right (for flowcharts). User picks from a dropdown.
- Group nodes: children are laid out first, then groups are positioned relative to each other.

### Export

- **PNG:** Uses React Flow's `toImage()` utility. Option to export current viewport or full diagram.
- **SVG:** Vector output via the same approach.
- Exports write to a user-chosen path via Fleet's existing save dialog.

### Fleet Integration

- **Sidebar:** Diagram panes show a diamond/flowchart icon in the tab list. Tab label is `meta.title` or the filename.
- **Workspace persistence:** Diagram pane state (filePath, viewport) is saved in workspace layout JSON, same as file editor panes. Reopening a workspace restores diagram panes.
- **Quick Open / Telescope:** `.fleet-diagram.json` files appear in file search results. Opening one launches a diagram pane.
- **File editor fallback:** Right-click a diagram tab → "Open as JSON" opens the file in a text editor pane. Changes are picked up by the diagram pane's file watcher.
- **Command palette:** The four analyzer commands are registered as command palette actions.

### New Dependencies

| Package | Purpose |
|---------|---------|
| `@xyflow/react` | React Flow v12 — diagram engine |
| `@dagrejs/dagre` | Auto-layout |

No other new dependencies. Rich editing UI is built with existing shadcn/Radix + Tailwind.
