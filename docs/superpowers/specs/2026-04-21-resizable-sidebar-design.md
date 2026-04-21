# Resizable Sidebar — Design

## Goal

Let users resize the Fleet sidebar by dragging its right edge. Width is remembered per-workspace and persists across app restarts.

## Requirements

- Drag the sidebar's right edge to resize in real time.
- Double-click the drag handle to reset to the default width (224px / `w-56`).
- Width is stored on the `Workspace` object and restored when that workspace loads.
- Width is clamped: minimum 180px, maximum 90% of the current window width.
- Collapsed (mini) sidebar is unaffected.

## Architecture

### Data model

Add one optional field to the `Workspace` type:

```ts
// src/shared/types.ts
export type Workspace = {
  // …existing fields
  sidebarWidth?: number; // pixels; undefined = use DEFAULT_SIDEBAR_WIDTH
};
```

Optional + number-valued so legacy saved workspaces continue to load without migration.

### State

- `Sidebar` reads `workspace.sidebarWidth` from the workspace store via the existing `useWorkspaceStore` hook.
- A new store action `setSidebarWidth(width: number)` clamps the value, updates `workspace.sidebarWidth`, and sets `isDirty: true`. Persistence is handled by the existing debounced autosave in `Sidebar.tsx` (the same one that saves tab changes) plus the page-hide flush in `App.tsx`.
- The `switchWorkspace` and `loadWorkspace` actions already shallow-copy the incoming workspace, so `sidebarWidth` rides along for free.

### Constants

Defined in `Sidebar.tsx` (or a shared `sidebar-constants.ts` if re-used):

```ts
const DEFAULT_SIDEBAR_WIDTH = 224;  // matches w-56
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH_RATIO = 0.9; // of window.innerWidth
```

### Components

**`SidebarResizeHandle`** — new component in `src/renderer/src/components/SidebarResizeHandle.tsx`.

- Renders a 4px-wide absolutely-positioned strip on the right edge of the sidebar (`right: -2px; top: 0; bottom: 0;` inside a `relative` sidebar container).
- Cursor `col-resize` on hover and while dragging.
- Hover/active visual: subtle blue accent line (matches the existing `bg-blue-500` used elsewhere for drag affordances).
- Props: `onResize(width: number)`, `onReset()`, `sidebarRef: RefObject<HTMLDivElement>`.

Pointer-event logic:

```ts
const handlePointerDown = (e: React.PointerEvent) => {
  e.currentTarget.setPointerCapture(e.pointerId);
  setDragging(true);
  document.body.style.userSelect = 'none';
};

const handlePointerMove = (e: React.PointerEvent) => {
  if (!dragging) return;
  const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
  onResize(e.clientX - left); // clamp happens in store action
};

const handlePointerUp = (e: React.PointerEvent) => {
  e.currentTarget.releasePointerCapture(e.pointerId);
  setDragging(false);
  document.body.style.userSelect = '';
};

const handleDoubleClick = () => onReset();
```

**`Sidebar`** changes:

- Replace the outermost `<div>`'s fixed `w-56` class with inline `style={{ width: currentWidth }}`, and add the `relative` class so the handle can position absolutely against the sidebar.
- Render `<SidebarResizeHandle>` as a sibling at the end of the sidebar tree.
- `currentWidth = workspace.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH`.

### Window-resize handling

When the window shrinks, the stored width may exceed the new 90% max.

- A `window.resize` listener in `Sidebar` re-reads `window.innerWidth` and, if `currentWidth > innerWidth * 0.9`, calls `setSidebarWidth` to clamp down.
- Debounced with `requestAnimationFrame` to avoid thrash during live window drags.

### Clamping

The store action is the single source of clamping:

```ts
setSidebarWidth: (width) => set((s) => {
  const max = window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO;
  const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(width, max));
  return {
    workspace: { ...s.workspace, sidebarWidth: clamped },
    isDirty: true,
  };
}),
```

## Data flow

```
user drags handle
  → onPointerMove(clientX)
  → SidebarResizeHandle computes raw = clientX - sidebarLeft
  → setSidebarWidth(raw) in workspace-store
  → store clamps to [MIN, window * 0.9]
  → workspace.sidebarWidth updated + isDirty: true
  → Sidebar re-renders with new inline width
  → debounced autosave (500ms) persists workspace to disk
```

## Persistence

- Active workspace: saved via the existing autosave effect in `Sidebar.tsx` (triggered by `isDirty`).
- Page hide / visibility change: saved via the existing flush in `App.tsx`.
- Workspace switch: the outgoing workspace is flushed by existing `doSwitchWorkspace` logic; the incoming workspace's `sidebarWidth` is applied the moment the store swaps.
- Backward compat: a workspace file without `sidebarWidth` loads as `undefined`, and the sidebar falls back to `DEFAULT_SIDEBAR_WIDTH`.

## Edge cases

1. **Mini (collapsed) sidebar.** The resize handle is rendered inside the expanded-sidebar branch of `App.tsx`. When `sidebarCollapsed === true`, the mini sidebar renders with its fixed `w-11` — no handle, no resize. Unaffected.
2. **Workspace switch while dragging.** Unlikely, but if it happens, `pointerup` still fires on the handle's captured pointer; the `onResize` call writes to whatever workspace is current at the time. Acceptable.
3. **Window shrinks below `MIN_SIDEBAR_WIDTH / 0.9`.** The clamp still produces a valid width because `MIN` wins over `max`. In pathological cases (window narrower than 180px) the sidebar will exceed the 90% rule; that's a degenerate window size and acceptable.
4. **Touch devices / stylus.** Pointer events cover mouse, touch, and pen uniformly.
5. **Double-click vs. drag.** If the user double-clicks, `pointerdown`/`pointerup` fire twice in quick succession. The drag logic applies tiny width changes that get immediately overwritten by `onReset` — no flicker because both updates land in the same React tick.

## Files touched

| File | Change |
|------|--------|
| `src/shared/types.ts` | Add `sidebarWidth?: number` to `Workspace` |
| `src/renderer/src/store/workspace-store.ts` | Add `setSidebarWidth` action |
| `src/renderer/src/components/Sidebar.tsx` | Inline width style, mount `SidebarResizeHandle`, window-resize clamp |
| `src/renderer/src/components/SidebarResizeHandle.tsx` | **New** — pointer-event drag handle |

## Testing

- Manual verification (feature correctness requires browser):
  - Drag sidebar wider / narrower; verify real-time resize.
  - Release, reload app, confirm width restored.
  - Switch to another workspace; confirm its own width applies; switch back, original width returns.
  - Double-click handle; confirm reset to 224px.
  - Drag far left past 180px; confirm clamp at 180.
  - Drag far right past 90%; confirm clamp at 90%.
  - Shrink window below 2× sidebar width; confirm sidebar auto-clamps.
  - Collapse sidebar; confirm mini view unchanged. Re-expand; previous width preserved.
- Type check: `npm run typecheck`.
- Lint: `npm run lint`.

## Non-goals

- Global (cross-workspace) width preference.
- Snap points or keyboard resize shortcuts.
- Animated reset.
