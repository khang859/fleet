# Resizable Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drag the Fleet sidebar's right edge to resize it, with per-workspace persistence and double-click-to-reset.

**Architecture:** Add `sidebarWidth?: number` to the `Workspace` type so the value rides along with existing workspace persistence (debounced autosave + page-hide flush). A new `SidebarResizeHandle` component uses pointer events on a 4px strip on the sidebar's right edge. A new `setSidebarWidth` store action is the single source of clamping (min 180px, max 90% of `window.innerWidth`). The existing collapsed mini-sidebar is untouched.

**Tech Stack:** Electron + React 19 + TypeScript, Zustand store, Tailwind CSS, Vitest for unit tests. Spec: `docs/superpowers/specs/2026-04-21-resizable-sidebar-design.md`.

---

### Task 1: Add `sidebarWidth` to the `Workspace` type

**Files:**
- Modify: `src/shared/types.ts:1-8`

- [ ] **Step 1: Add the optional field**

Edit `src/shared/types.ts`. Change the `Workspace` type from:

```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string;
  activePaneId?: string;
  collapsedGroups?: string[];
};
```

to:

```ts
export type Workspace = {
  id: string;
  label: string;
  tabs: Tab[];
  activeTabId?: string;
  activePaneId?: string;
  collapsedGroups?: string[];
  /** Pixel width of the expanded sidebar. Undefined = use DEFAULT_SIDEBAR_WIDTH. */
  sidebarWidth?: number;
};
```

- [ ] **Step 2: Verify typecheck passes**

Run: `npm run typecheck`
Expected: both `typecheck:node` and `typecheck:web` pass with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add optional sidebarWidth to Workspace"
```

---

### Task 2: Add sidebar-width constants and `setSidebarWidth` store action

**Files:**
- Create: `src/renderer/src/components/sidebar-constants.ts`
- Modify: `src/renderer/src/store/workspace-store.ts` (add to `WorkspaceStore` type around line 163, and add implementation near `renameWorkspace` around line 872)
- Create: `src/renderer/src/store/__tests__/sidebar-width.test.ts`

- [ ] **Step 1: Create shared constants file**

Create `src/renderer/src/components/sidebar-constants.ts`:

```ts
/** Default sidebar width in pixels (matches Tailwind `w-56` = 14rem = 224px). */
export const DEFAULT_SIDEBAR_WIDTH = 224;

/** Minimum resizable sidebar width — below this, tab labels become unreadable. */
export const MIN_SIDEBAR_WIDTH = 180;

/** Maximum sidebar width as a fraction of `window.innerWidth`. */
export const MAX_SIDEBAR_WIDTH_RATIO = 0.9;

/**
 * Clamp a raw sidebar width (pixels) against min/max bounds.
 * `viewportWidth` must be provided so the function is testable without `window`.
 */
export function clampSidebarWidth(rawWidth: number, viewportWidth: number): number {
  const max = viewportWidth * MAX_SIDEBAR_WIDTH_RATIO;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(rawWidth, max));
}
```

- [ ] **Step 2: Write failing test for `clampSidebarWidth`**

Create `src/renderer/src/store/__tests__/sidebar-width.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  clampSidebarWidth,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH_RATIO,
  DEFAULT_SIDEBAR_WIDTH
} from '../../components/sidebar-constants';

describe('clampSidebarWidth', () => {
  it('returns the raw width when within bounds', () => {
    expect(clampSidebarWidth(300, 1600)).toBe(300);
  });

  it('clamps up to MIN_SIDEBAR_WIDTH when below min', () => {
    expect(clampSidebarWidth(50, 1600)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('clamps down to 90% of viewport when above max', () => {
    expect(clampSidebarWidth(9999, 1000)).toBe(1000 * MAX_SIDEBAR_WIDTH_RATIO);
  });

  it('MIN wins over max in pathologically small viewports', () => {
    // viewport 100px → max = 90px, but MIN_SIDEBAR_WIDTH (180) wins
    expect(clampSidebarWidth(50, 100)).toBe(MIN_SIDEBAR_WIDTH);
  });

  it('DEFAULT_SIDEBAR_WIDTH is within bounds for a typical viewport', () => {
    expect(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, 1600)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
```

- [ ] **Step 3: Run test — verify it passes**

Run: `npm test -- src/renderer/src/store/__tests__/sidebar-width.test.ts`
Expected: all 5 tests pass. (The function is already implemented in Step 1, so the test should pass immediately. This is a regression test rather than strict TDD because the function is a pure clamp helper with no design ambiguity.)

- [ ] **Step 4: Add `setSidebarWidth` to the store type**

Edit `src/renderer/src/store/workspace-store.ts`. Find the `renameWorkspace` line in the `WorkspaceStore` type around line 164:

```ts
  renameWorkspace: (label: string) => void;
  markClean: () => void;
```

Add `setSidebarWidth` right after `renameWorkspace`:

```ts
  renameWorkspace: (label: string) => void;
  setSidebarWidth: (width: number) => void;
  markClean: () => void;
```

- [ ] **Step 5: Add `setSidebarWidth` implementation**

In the same file, find the `renameWorkspace` implementation around line 872. Add `setSidebarWidth` right after it (before `markClean`):

```ts
  renameWorkspace: (label) => {
    set((state) => ({
      workspace: { ...state.workspace, label },
      isDirty: true
    }));
  },

  setSidebarWidth: (width) => {
    const clamped = clampSidebarWidth(width, window.innerWidth);
    set((state) => {
      if (state.workspace.sidebarWidth === clamped) return state;
      return {
        workspace: { ...state.workspace, sidebarWidth: clamped },
        isDirty: true
      };
    });
  },

  markClean: () => set({ isDirty: false }),
```

- [ ] **Step 6: Add the import for `clampSidebarWidth`**

At the top of `src/renderer/src/store/workspace-store.ts`, add to the imports near line 1-6:

```ts
import { clampSidebarWidth } from '../components/sidebar-constants';
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: typecheck passes; the new `sidebar-width.test.ts` and all existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/sidebar-constants.ts src/renderer/src/store/workspace-store.ts src/renderer/src/store/__tests__/sidebar-width.test.ts
git commit -m "feat(workspace): add setSidebarWidth action with clamping"
```

---

### Task 3: Create the `SidebarResizeHandle` component

**Files:**
- Create: `src/renderer/src/components/SidebarResizeHandle.tsx`

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/SidebarResizeHandle.tsx`:

```tsx
import { useCallback, useRef, useState } from 'react';

/**
 * Drag handle on the right edge of the sidebar. Emits raw pixel widths;
 * clamping happens in the consumer's store action.
 *
 * Uses pointer events (not mouse events) so touch and stylus work too.
 */
export function SidebarResizeHandle({
  sidebarRef,
  onResize,
  onReset
}: {
  sidebarRef: React.RefObject<HTMLDivElement | null>;
  onResize: (widthPx: number) => void;
  onReset: () => void;
}): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const previousUserSelectRef = useRef<string>('');

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Left button only; ignore right/middle clicks
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsDragging(true);
    previousUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDragging) return;
      const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      onResize(e.clientX - left);
    },
    [isDragging, onResize, sidebarRef]
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
    document.body.style.userSelect = previousUserSelectRef.current;
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      className={`absolute top-0 bottom-0 -right-0.5 w-1 cursor-col-resize z-20 group ${
        isDragging ? '' : 'hover:bg-blue-500/0'
      }`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onReset}
    >
      {/* Visual accent — transparent by default, blue on hover/active */}
      <div
        className={`absolute top-0 bottom-0 left-0 right-0 transition-colors ${
          isDragging ? 'bg-blue-500/80' : 'bg-transparent group-hover:bg-blue-500/50'
        }`}
      />
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/SidebarResizeHandle.tsx
git commit -m "feat(sidebar): add SidebarResizeHandle component"
```

---

### Task 4: Wire the resize handle into `Sidebar.tsx`

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports**

Edit `src/renderer/src/components/Sidebar.tsx`. Near the other component/store imports at the top of the file, add:

```tsx
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { DEFAULT_SIDEBAR_WIDTH } from './sidebar-constants';
```

- [ ] **Step 2: Read `sidebarWidth` and `setSidebarWidth` from the store**

In `Sidebar.tsx`, find the `useWorkspaceStore(useShallow(...))` call around line 404. Add `sidebarWidth` (pulled from `s.workspace.sidebarWidth`) and `setSidebarWidth` to the destructured shape. Update the destructure + selector so they read:

```tsx
  const {
    workspace,
    activeTabId,
    activePaneId,
    setActiveTab,
    closeTab,
    renameTab,
    resetTabLabel,
    addTab,
    reorderTab,
    reorderGroup,
    renameWorkspace,
    isDirty,
    markClean,
    collapsedGroups,
    toggleGroupCollapsed,
    createWorktreeGroup,
    closeWorktreeTab,
    renameWorktreeGroup,
    worktreeCloseConfirm,
    setWorktreeCloseConfirm,
    setSidebarWidth
  } = useWorkspaceStore(
    useShallow((s) => ({
      workspace: s.workspace,
      activeTabId: s.activeTabId,
      activePaneId: s.activePaneId,
      setActiveTab: s.setActiveTab,
      closeTab: s.closeTab,
      renameTab: s.renameTab,
      resetTabLabel: s.resetTabLabel,
      addTab: s.addTab,
      reorderTab: s.reorderTab,
      reorderGroup: s.reorderGroup,
      renameWorkspace: s.renameWorkspace,
      isDirty: s.isDirty,
      markClean: s.markClean,
      collapsedGroups: s.collapsedGroups,
      toggleGroupCollapsed: s.toggleGroupCollapsed,
      createWorktreeGroup: s.createWorktreeGroup,
      closeWorktreeTab: s.closeWorktreeTab,
      renameWorktreeGroup: s.renameWorktreeGroup,
      worktreeCloseConfirm: s.worktreeCloseConfirm,
      setWorktreeCloseConfirm: s.setWorktreeCloseConfirm,
      setSidebarWidth: s.setSidebarWidth
    }))
  );
```

- [ ] **Step 3: Compute current width**

Below the `useWorkspaceStore` destructure, add:

```tsx
  const currentSidebarWidth = workspace.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH;
```

- [ ] **Step 4: Add a ref for the sidebar root**

Near the other `useRef` calls (e.g., `tabListRef`), add:

```tsx
  const sidebarRootRef = useRef<HTMLDivElement>(null);
```

- [ ] **Step 5: Replace the fixed-width outer div with inline width + ref**

Find the outermost returned `<div>` around line 964:

```tsx
    <div className="flex flex-col h-full w-56 bg-neutral-900 border-r border-neutral-800">
```

Replace with:

```tsx
    <div
      ref={sidebarRootRef}
      className="relative flex flex-col h-full bg-neutral-900 border-r border-neutral-800 shrink-0"
      style={{ width: currentSidebarWidth }}
    >
```

Notes:
- Dropped `w-56`; width now comes from `style`.
- Added `relative` so `SidebarResizeHandle`'s `absolute` positioning is anchored here.
- Added `shrink-0` so the flex parent (`App.tsx`'s row) doesn't squash the sidebar.

- [ ] **Step 6: Render the handle at the end of the sidebar JSX**

Find the closing `</div>` of the sidebar's outermost container (currently the last line before the component function's closing brace, around line 1481). Just before that closing `</div>`, insert:

```tsx
      {/* Right-edge drag handle for resizing */}
      <SidebarResizeHandle
        sidebarRef={sidebarRootRef}
        onResize={setSidebarWidth}
        onReset={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      />
```

- [ ] **Step 7: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 8: Manual browser check — drag and reset**

Run: `npm run dev`

In the running Fleet app:
1. Hover the right edge of the sidebar — cursor should become `col-resize` and a blue accent should appear.
2. Drag left and right — sidebar resizes in real time.
3. Release at ~400px — width should stick.
4. Drag left past 180px — should clamp at 180px.
5. Drag right past 90% of window — should clamp at 90%.
6. Double-click the handle — sidebar should reset to 224px.
7. Restart the app — resized width should persist for the current workspace.
8. Create a new workspace — confirm it starts at 224px. Resize it. Switch back to the first workspace — confirm its width is preserved independently.
9. Collapse the sidebar with the existing collapse button — confirm mini sidebar (11px) is unaffected and has no handle.

If all checks pass, proceed. If any fail, diagnose and fix before committing.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(sidebar): make sidebar resizable via drag handle"
```

---

### Task 5: Auto-clamp when the window shrinks

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Add imports for clamp constants**

In `src/renderer/src/components/Sidebar.tsx`, update the existing sidebar-constants import to also pull clamp constants:

```tsx
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH_RATIO
} from './sidebar-constants';
```

- [ ] **Step 2: Add window-resize effect**

Inside the `Sidebar` component, after the existing `useEffect` hooks (e.g., near the auto-save effect around line 660), add:

```tsx
  // Clamp sidebar width when window shrinks below 2× sidebar width
  useEffect(() => {
    const handleWindowResize = (): void => {
      const max = window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO;
      if (currentSidebarWidth > max) {
        setSidebarWidth(max);
      }
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [currentSidebarWidth, setSidebarWidth]);
```

- [ ] **Step 3: Run typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: both pass.

- [ ] **Step 4: Manual browser check — window resize clamping**

Run: `npm run dev` (if not already running).

1. Resize the sidebar to ~600px.
2. Shrink the Electron window to ~500px total width.
3. The sidebar should auto-clamp down so it never exceeds 90% of the window (≤450px in this case).
4. Enlarge the window again — sidebar stays at the clamped width (by design; we only clamp down, not back up).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(sidebar): clamp sidebar width when window shrinks"
```

---

### Task 6: Final verification

**Files:** (none — verification only)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: both `typecheck:node` and `typecheck:web` pass.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: passes with no new warnings.

- [ ] **Step 3: Tests**

Run: `npm test`
Expected: all tests pass, including the new `sidebar-width.test.ts`.

- [ ] **Step 4: End-to-end manual walkthrough**

Run the full manual verification list from the spec's Testing section:
- Drag wider / narrower — real-time resize works.
- Release, reload app, width restored for current workspace.
- Switch workspace; its own width applies; switch back, original restored.
- Double-click handle — resets to 224px.
- Drag past 180px min — clamp holds.
- Drag past 90% max — clamp holds.
- Shrink window below 2× sidebar width — auto-clamps.
- Collapse sidebar — mini-sidebar unchanged, no handle.
- Re-expand — previous width preserved.

- [ ] **Step 5: Confirm nothing broke in the existing sidebar**

Spot-check existing sidebar behaviors still work:
- Add a new tab with the `+` button.
- Drag a tab to reorder.
- Rename a workspace.
- Create a worktree group.
- Open/close Settings tab.

If anything regressed, diagnose before moving on.

- [ ] **Step 6: Final announcement**

No commit needed (verification only). Report completion to the user: "Resizable sidebar implemented across 5 commits. All typecheck/lint/tests pass. Manual walkthrough verified."
