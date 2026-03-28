# Copilot Panel Direction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the copilot chat panel open toward the side with more screen space, based on the sprite's position when expanding.

**Architecture:** Main process calculates direction (two-axis comparison of sprite center vs display center), positions the window accordingly, and sends the direction to the renderer. Renderer uses the direction to flip the panel CSS from `top` to `bottom` when opening upward.

**Tech Stack:** Electron (BrowserWindow, screen API), React, Zustand, TypeScript

---

### Task 1: Add direction type and update IPC payload in main process

**Files:**
- Modify: `src/main/copilot/copilot-window.ts:200-233`

- [ ] **Step 1: Add direction type at the top of the file**

After the existing constants (line 15), add:

```typescript
export type PanelDirection = {
  horizontal: 'left' | 'right';
  vertical: 'up' | 'down';
};
```

- [ ] **Step 2: Add `calculateDirection` private method**

Add this method to the `CopilotWindow` class, before `applyExpanded`:

```typescript
private calculateDirection(): PanelDirection {
  if (!this.win || this.win.isDestroyed()) {
    return { horizontal: 'left', vertical: 'down' };
  }
  const bounds = this.win.getBounds();
  const cx = bounds.x + COLLAPSED_SIZE / 2;
  const cy = bounds.y + COLLAPSED_SIZE / 2;
  const display = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const dx = display.bounds.x + display.bounds.width / 2;
  const dy = display.bounds.y + display.bounds.height / 2;
  return {
    horizontal: cx < dx ? 'right' : 'left',
    vertical: cy < dy ? 'down' : 'up',
  };
}
```

- [ ] **Step 3: Update `applyExpanded` to use direction-aware positioning**

Replace the `applyExpanded` method body with:

```typescript
private applyExpanded(): void {
  if (!this.win || this.win.isDestroyed()) return;
  const bounds = this.win.getBounds();

  if (this.expanded) {
    this.collapsedPos = { x: bounds.x, y: bounds.y };
    const dir = this.calculateDirection();

    const x = dir.horizontal === 'left'
      ? bounds.x - (EXPANDED_WIDTH - COLLAPSED_SIZE)
      : bounds.x;
    const y = dir.vertical === 'up'
      ? bounds.y - EXPANDED_HEIGHT
      : bounds.y;

    const newBounds = {
      x,
      y,
      width: EXPANDED_WIDTH,
      height: COLLAPSED_SIZE + EXPANDED_HEIGHT,
    };
    log.info('expanding to', { ...newBounds, direction: dir });
    this.win.setBounds(newBounds);
    this.win.setAlwaysOnTop(true, 'pop-up-menu');

    this.win.webContents.send('copilot:expanded-changed', {
      expanded: true,
      direction: dir,
    });
  } else {
    const x = this.collapsedPos?.x ?? bounds.x + (bounds.width - COLLAPSED_SIZE);
    const y = this.collapsedPos?.y ?? bounds.y;
    const newBounds = {
      x,
      y,
      width: COLLAPSED_SIZE,
      height: COLLAPSED_SIZE,
    };
    log.info('collapsing to', newBounds);
    this.win.setBounds(newBounds);
    this.win.setAlwaysOnTop(true, 'floating');

    this.win.webContents.send('copilot:expanded-changed', {
      expanded: false,
      direction: null,
    });
  }
}
```

Note: the old `this.win.webContents.send('copilot:expanded-changed', this.expanded)` at the end of the method is removed — each branch now sends its own message with the new payload shape.

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: Errors in `src/preload/copilot.ts` and `src/renderer/copilot/src/store/copilot-store.ts` because they still expect a `boolean` payload. That's expected — we fix those next.

- [ ] **Step 5: Commit**

```bash
git add src/main/copilot/copilot-window.ts
git commit -m "feat(copilot): add direction-aware panel expansion in main process"
```

---

### Task 2: Update preload to pass direction to renderer

**Files:**
- Modify: `src/preload/copilot.ts:60-66`

- [ ] **Step 1: Update `onExpandedChanged` handler**

Replace lines 60-66 in `src/preload/copilot.ts`:

```typescript
onExpandedChanged: (
  cb: (expanded: boolean, direction: { horizontal: 'left' | 'right'; vertical: 'up' | 'down' } | null) => void
): (() => void) => {
  const handler = (
    _event: Electron.IpcRendererEvent,
    data: { expanded: boolean; direction: { horizontal: 'left' | 'right'; vertical: 'up' | 'down' } | null }
  ): void => {
    cb(data.expanded, data.direction);
  };
  ipcRenderer.on('copilot:expanded-changed', handler);
  return () => ipcRenderer.removeListener('copilot:expanded-changed', handler);
},
```

- [ ] **Step 2: Commit**

```bash
git add src/preload/copilot.ts
git commit -m "feat(copilot): update preload to pass panel direction from IPC"
```

---

### Task 3: Update store and App.tsx to use direction

**Files:**
- Modify: `src/renderer/copilot/src/store/copilot-store.ts:31,62-64`
- Modify: `src/renderer/copilot/src/App.tsx:10,21,54-62`

- [ ] **Step 1: Add direction state and update setExpanded in store**

In `src/renderer/copilot/src/store/copilot-store.ts`, add to the state interface (after `expanded: boolean`):

```typescript
panelDirection: { horizontal: 'left' | 'right'; vertical: 'up' | 'down' } | null;
```

Add to the actions interface (update `setExpanded` signature):

```typescript
setExpanded: (expanded: boolean, direction: { horizontal: 'left' | 'right'; vertical: 'up' | 'down' } | null) => void;
```

Add default in the store initial state:

```typescript
panelDirection: null,
```

Update `setExpanded` implementation:

```typescript
setExpanded: (expanded, direction) => {
  log.info('setExpanded (from main)', { expanded, direction });
  set({ expanded, panelDirection: direction, view: expanded ? get().view : 'sessions' });
},
```

- [ ] **Step 2: Update App.tsx to read direction and apply conditional CSS**

In `src/renderer/copilot/src/App.tsx`:

Add `panelDirection` to the store selectors:

```typescript
const panelDirection = useCopilotStore((s) => s.panelDirection);
```

Update the `onExpandedChanged` subscription to pass direction:

```typescript
const cleanupExpanded = window.copilot.onExpandedChanged(setExpanded);
```

(This line stays the same — `setExpanded` now accepts both args.)

Update the panel positioning div. Replace:

```tsx
<div
  className="absolute top-[132px] right-0 left-0 h-[450px]"
  style={{ zIndex: 10 }}
>
```

With:

```tsx
<div
  className={`absolute right-0 left-0 h-[450px] ${
    panelDirection?.vertical === 'up' ? 'bottom-[132px]' : 'top-[132px]'
  }`}
  style={{ zIndex: 10 }}
>
```

- [ ] **Step 3: Update sprite positioning for upward expansion**

In `src/renderer/copilot/src/App.tsx`, update the sprite wrapper to position the sprite at the bottom when panel opens upward. Replace:

```tsx
<div className="flex justify-end">
  <SpaceshipSprite />
</div>
```

With:

```tsx
<div className={`flex justify-end ${
  expanded && panelDirection?.vertical === 'up' ? 'absolute bottom-0 right-0 left-0' : ''
}`}>
  <SpaceshipSprite />
</div>
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — all types now align across main, preload, and renderer.

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/copilot/src/store/copilot-store.ts src/renderer/copilot/src/App.tsx
git commit -m "feat(copilot): render panel direction-aware in renderer"
```

---

### Task 4: Manual testing

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Test bottom-right position (default)**

Drag the copilot sprite to the bottom-right corner of the screen. Click to expand. Verify the panel opens **upward and to the left**.

- [ ] **Step 3: Test top-right position**

Drag the sprite to the top-right. Click to expand. Verify the panel opens **downward and to the left** (original behavior).

- [ ] **Step 4: Test top-left position**

Drag the sprite to the top-left. Click to expand. Verify the panel opens **downward and to the right**.

- [ ] **Step 5: Test bottom-left position**

Drag the sprite to the bottom-left. Click to expand. Verify the panel opens **upward and to the right**.

- [ ] **Step 6: Test collapse/re-expand**

Collapse and re-expand from each position. Verify the sprite returns to its original position after collapsing.
