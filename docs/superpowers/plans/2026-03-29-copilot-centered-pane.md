# Copilot Centered Rich Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the copilot's small anchored side panel with a centered 600x500 rich pane that the mascot teleports into.

**Architecture:** Resize the existing transparent Electron BrowserWindow to cover the full display work area on expand. Render a backdrop + centered pane in the same renderer. Mascot transitions between floating mode (128x128, draggable) and header mode (48x48, click-to-close) with a flash teleport animation.

**Tech Stack:** Electron BrowserWindow, React, Zustand, Tailwind CSS, CSS keyframe animations

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/main/copilot/copilot-window.ts` | Modify | Full-display resize on expand, remove direction logic |
| `src/preload/copilot.ts` | Modify | Remove `direction` from `onExpandedChanged` callback |
| `src/renderer/copilot/src/store/copilot-store.ts` | Modify | Remove `panelDirection`, simplify `setExpanded` |
| `src/renderer/copilot/src/App.tsx` | Modify | New centered pane layout with backdrop |
| `src/renderer/copilot/src/components/SpaceshipSprite.tsx` | Modify | Add `mode` prop for floating vs header rendering |
| `src/renderer/copilot/src/index.css` | Modify | Add teleport keyframe animations |

---

### Task 1: Strip Panel Direction from Main Process

Remove the directional expand logic from `copilot-window.ts`. The window now expands to cover the full display work area and collapses back to 128x128.

**Files:**
- Modify: `src/main/copilot/copilot-window.ts`

- [ ] **Step 1: Rewrite `applyExpanded` to use full display work area**

Replace the entire `applyExpanded` method and remove `calculateDirection`, `EXPANDED_WIDTH`, `EXPANDED_HEIGHT`, and `PanelDirection`:

```typescript
// At the top of the file, REMOVE these lines:
// const EXPANDED_WIDTH = 350;
// const EXPANDED_HEIGHT = 500;
//
// export type PanelDirection = {
//   horizontal: 'left' | 'right';
//   vertical: 'up' | 'down';
// };

// REMOVE the entire calculateDirection method.

// Replace the applyExpanded method with:
private applyExpanded(): void {
  if (!this.win || this.win.isDestroyed()) return;
  const bounds = this.win.getBounds();

  if (this.expanded) {
    this.collapsedPos = { x: bounds.x, y: bounds.y };
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const workArea = display.workArea;

    const newBounds = {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height,
    };
    log.info('expanding to full display', newBounds);
    this.win.setBounds(newBounds);
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    this.win.setIgnoreMouseEvents(false);

    this.win.webContents.send('copilot:expanded-changed', {
      expanded: true,
    });
  } else {
    const x = this.collapsedPos?.x ?? bounds.x;
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
    });
  }
}
```

- [ ] **Step 2: Simplify `setPosition` to remove direction-aware clamping**

Replace the `setPosition` method:

```typescript
setPosition(x: number, y: number): void {
  const display = screen.getDisplayNearestPoint({ x, y });
  const { x: dx, y: dy, width, height } = display.workArea;

  // When expanded, window covers full display — don't allow drag repositioning
  if (this.expanded) return;

  const clampedX = Math.max(dx, Math.min(x, dx + width - COLLAPSED_SIZE));
  const clampedY = Math.max(dy, Math.min(y, dy + height - COLLAPSED_SIZE));

  if (this.win && !this.win.isDestroyed()) {
    this.win.setPosition(Math.round(clampedX), Math.round(clampedY));
  }

  this.positionStore.set('position', { x: clampedX, y: clampedY, displayId: display.id });
}
```

- [ ] **Step 3: Verify the file compiles**

Run: `npm run typecheck:node`
Expected: PASS (no type errors in main process)

- [ ] **Step 4: Commit**

```bash
git add src/main/copilot/copilot-window.ts
git commit -m "refactor(copilot): replace directional expand with full-display resize"
```

---

### Task 2: Remove Direction from Preload and Store

Strip `panelDirection` and `direction` params from the IPC bridge and Zustand store.

**Files:**
- Modify: `src/preload/copilot.ts`
- Modify: `src/renderer/copilot/src/store/copilot-store.ts`

- [ ] **Step 1: Simplify `onExpandedChanged` in preload**

In `src/preload/copilot.ts`, replace the `onExpandedChanged` method:

```typescript
onExpandedChanged: (
  cb: (expanded: boolean) => void
): (() => void) => {
  const handler = (
    _event: Electron.IpcRendererEvent,
    data: { expanded: boolean }
  ): void => {
    cb(data.expanded);
  };
  ipcRenderer.on('copilot:expanded-changed', handler);
  return () => ipcRenderer.removeListener('copilot:expanded-changed', handler);
},
```

- [ ] **Step 2: Update the store to remove `panelDirection`**

In `src/renderer/copilot/src/store/copilot-store.ts`:

1. Remove `panelDirection` from the `CopilotStoreState` type:
```typescript
// REMOVE this line from the type:
// panelDirection: { horizontal: 'left' | 'right'; vertical: 'up' | 'down' } | null;
```

2. Update the `setExpanded` signature and implementation:
```typescript
// In the type definition, change:
setExpanded: (expanded: boolean) => void;

// In the store implementation, change:
setExpanded: (expanded) => {
  log.info('setExpanded (from main)', { expanded });
  set({ expanded, view: expanded ? get().view : 'sessions' });
},
```

3. Remove `panelDirection: null` from the initial state.

- [ ] **Step 3: Verify types compile**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/copilot.ts src/renderer/copilot/src/store/copilot-store.ts
git commit -m "refactor(copilot): remove panelDirection from preload and store"
```

---

### Task 3: Add Teleport CSS Animations

Add the teleport flash-out and flash-in keyframe animations to the copilot stylesheet.

**Files:**
- Modify: `src/renderer/copilot/src/index.css`

- [ ] **Step 1: Add teleport keyframes**

Append to `src/renderer/copilot/src/index.css`:

```css
@keyframes teleport-out {
  0% { opacity: 1; filter: brightness(1); }
  40% { opacity: 1; filter: brightness(3); }
  100% { opacity: 0; filter: brightness(3); }
}

@keyframes teleport-in {
  0% { opacity: 0; filter: brightness(3); }
  40% { opacity: 1; filter: brightness(3); }
  100% { opacity: 1; filter: brightness(1); }
}

.animate-teleport-out {
  animation: teleport-out 200ms ease-out forwards;
}

.animate-teleport-in {
  animation: teleport-in 200ms ease-in forwards;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/copilot/src/index.css
git commit -m "feat(copilot): add teleport flash animation keyframes"
```

---

### Task 4: Add Header Mode to SpaceshipSprite

Add a `mode` prop to `SpaceshipSprite` that switches between floating (128x128, draggable, click-to-expand) and header (48x48, no drag, click-to-close).

**Files:**
- Modify: `src/renderer/copilot/src/components/SpaceshipSprite.tsx`

- [ ] **Step 1: Add `mode` prop and conditional rendering**

Replace the full `SpaceshipSprite` component:

```tsx
const SPRITE_SIZE = 128;
const HEADER_SPRITE_SIZE = 48;
const DRAG_THRESHOLD = 4;

type SpaceshipSpriteProps = {
  mode?: 'floating' | 'header';
  teleportState?: 'idle' | 'out' | 'in';
};

export function SpaceshipSprite({
  mode = 'floating',
  teleportState = 'idle',
}: SpaceshipSpriteProps): React.JSX.Element {
  const spriteState = useSpriteState();
  const frameIndex = useSpriteAnimation(spriteState);
  const toggleExpanded = useCopilotStore((s) => s.toggleExpanded);
  const settings = useCopilotStore((s) => s.settings);
  const spriteSheet = getSpriteSheet(settings?.spriteSheet ?? 'officer');

  const wasDragged = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (mode === 'header') return; // No dragging in header mode
    wasDragged.current = false;
    dragStartPos.current = { x: e.screenX, y: e.screenY };

    window.copilot.getPosition().then((pos) => {
      if (pos) {
        windowStartPos.current = { x: pos.x, y: pos.y };
      }
    });

    const handleMouseMove = (ev: MouseEvent): void => {
      const dx = ev.screenX - dragStartPos.current.x;
      const dy = ev.screenY - dragStartPos.current.y;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        wasDragged.current = true;
        window.copilot.setPosition(
          windowStartPos.current.x + dx,
          windowStartPos.current.y + dy
        );
      }
    };

    const handleMouseUp = (): void => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [mode]);

  const handleClick = useCallback(() => {
    if (mode === 'floating' && wasDragged.current) return;
    toggleExpanded();
  }, [toggleExpanded, mode]);

  const size = mode === 'header' ? HEADER_SPRITE_SIZE : SPRITE_SIZE;

  const animationClass = mode === 'floating' ? {
    idle: 'animate-bob',
    processing: 'animate-thrust',
    permission: 'animate-pulse-amber',
    complete: 'animate-flash-green',
  }[spriteState] : '';

  const teleportClass = teleportState === 'out'
    ? 'animate-teleport-out'
    : teleportState === 'in'
      ? 'animate-teleport-in'
      : '';

  return (
    <div
      className={`cursor-pointer select-none ${animationClass} ${teleportClass}`}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${spriteSheet})`,
        backgroundPosition: `-${frameIndex * size}px 0`,
        backgroundSize: `${size * 9}px ${size}px`,
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
      }}
    />
  );
}
```

Note: The background math scales proportionally for header mode. When `size` is 48, `backgroundPosition` becomes `-${frameIndex * 48}px 0` and `backgroundSize` becomes `${48 * 9}px ${48}px`. This works because the sprite sheet frames are square and the browser handles the downscaling with `image-rendering: pixelated`.

- [ ] **Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/copilot/src/components/SpaceshipSprite.tsx
git commit -m "feat(copilot): add header mode and teleport state to SpaceshipSprite"
```

---

### Task 5: Rewrite App.tsx with Centered Pane Layout

Replace the directional panel layout with the centered pane + backdrop. Orchestrate the teleport animation state machine.

**Files:**
- Modify: `src/renderer/copilot/src/App.tsx`

- [ ] **Step 1: Rewrite App.tsx**

Replace the entire file:

```tsx
import { useEffect, useState, useCallback } from 'react';
import './index.css';
import { useCopilotStore } from './store/copilot-store';
import { SpaceshipSprite } from './components/SpaceshipSprite';
import { SessionList } from './components/SessionList';
import { SessionDetail } from './components/SessionDetail';
import { CopilotSettings } from './components/CopilotSettings';
import { MascotPicker } from './components/MascotPicker';
import { CrtFrame } from './components/CrtFrame';

type TeleportPhase = 'idle' | 'flash-out' | 'transitioning' | 'flash-in';

const TELEPORT_FLASH_MS = 200;

export function App(): React.JSX.Element {
  const expanded = useCopilotStore((s) => s.expanded);
  const view = useCopilotStore((s) => s.view);
  const setSessions = useCopilotStore((s) => s.setSessions);
  const loadSettings = useCopilotStore((s) => s.loadSettings);
  const setExpanded = useCopilotStore((s) => s.setExpanded);

  // Teleport animation state machine
  const [teleportPhase, setTeleportPhase] = useState<TeleportPhase>('idle');
  const [showPane, setShowPane] = useState(false);

  // Track the previous expanded state to detect transitions
  const [prevExpanded, setPrevExpanded] = useState(false);

  useEffect(() => {
    if (expanded === prevExpanded) return;
    setPrevExpanded(expanded);

    if (expanded) {
      // Expanding: flash out floating mascot → show pane → flash in header mascot
      setTeleportPhase('flash-out');
      setTimeout(() => {
        setShowPane(true);
        setTeleportPhase('flash-in');
        setTimeout(() => {
          setTeleportPhase('idle');
        }, TELEPORT_FLASH_MS);
      }, TELEPORT_FLASH_MS);
    } else {
      // Collapsing: flash out header mascot → hide pane → flash in floating mascot
      setTeleportPhase('flash-out');
      setTimeout(() => {
        setShowPane(false);
        setTeleportPhase('flash-in');
        setTimeout(() => {
          setTeleportPhase('idle');
        }, TELEPORT_FLASH_MS);
      }, TELEPORT_FLASH_MS);
    }
  }, [expanded, prevExpanded]);

  const handleClose = useCallback(() => {
    window.copilot.setExpanded(false);
  }, []);

  // IPC subscriptions
  useEffect(() => {
    if (!window.copilot) return;
    window.copilot.getSessions().then(setSessions).catch(() => {});
    loadSettings().catch(() => {});
    const cleanupSessions = window.copilot.onSessions(setSessions);
    const cleanupExpanded = window.copilot.onExpandedChanged(setExpanded);
    return () => {
      cleanupSessions();
      cleanupExpanded();
    };
  }, [setSessions, loadSettings, setExpanded]);

  // Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && expanded) {
        window.copilot.setExpanded(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  // Subscribe to real-time chat updates
  useEffect(() => {
    if (!window.copilot) return;
    const setChatMessages = useCopilotStore.getState().setChatMessages;
    const unsub = window.copilot.onChatUpdated(({ sessionId, messages }) => {
      setChatMessages(sessionId, messages);
    });
    return unsub;
  }, []);

  // Determine teleport visual state for the sprite
  const spriteTeleportState = teleportPhase === 'flash-out' || teleportPhase === 'flash-in'
    ? (teleportPhase === 'flash-out' ? 'out' : 'in')
    : 'idle';

  return (
    <div className="relative w-full h-full">
      {/* Floating mascot — visible when pane is NOT shown */}
      {!showPane && (
        <div className="flex justify-end">
          <SpaceshipSprite
            mode="floating"
            teleportState={spriteTeleportState}
          />
        </div>
      )}

      {/* Centered pane with backdrop — visible when pane IS shown */}
      {showPane && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ background: 'rgba(0, 0, 0, 0.6)' }}
          onClick={handleClose}
        >
          <div
            className="flex flex-col"
            style={{ width: 600, height: 500 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Pane header with mascot */}
            <div className="flex items-center gap-3 px-4 py-2 shrink-0">
              <SpaceshipSprite
                mode="header"
                teleportState={spriteTeleportState}
              />
              <span className="text-white text-sm font-medium tracking-wide opacity-70">
                Fleet Copilot
              </span>
            </div>

            {/* Pane body */}
            <div className="flex-1 min-h-0">
              <CrtFrame>
                {view === 'sessions' && <SessionList />}
                {view === 'detail' && <SessionDetail />}
                {view === 'settings' && <CopilotSettings />}
                {view === 'mascots' && <MascotPicker />}
              </CrtFrame>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Verify the build succeeds**

Run: `npm run build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/copilot/src/App.tsx
git commit -m "feat(copilot): centered rich pane with backdrop and teleport animation"
```

---

### Task 6: Manual Testing and Polish

Verify the full flow works end-to-end in dev mode.

**Files:**
- Possibly modify: any of the above files for fixes

- [ ] **Step 1: Start dev mode**

Run: `npm run dev`

- [ ] **Step 2: Test expand flow**

1. Click the floating mascot → should flash out, pane appears centered with backdrop, mascot flashes in at header
2. Verify the pane is ~600x500, centered on screen
3. Verify the backdrop is semi-transparent dark overlay

- [ ] **Step 3: Test close triggers**

1. Click the mascot in the header → pane closes, mascot teleports back to floating position
2. Re-open, then click the backdrop → pane closes
3. Re-open, then press Escape → pane closes
4. Verify the mascot returns to its original floating position each time

- [ ] **Step 4: Test views inside the pane**

1. Verify sessions list renders in the larger space
2. Click a session → detail view loads
3. Navigate to settings → settings render
4. Navigate to mascot picker → picker renders
5. Close and re-open → should reset to sessions view

- [ ] **Step 5: Test drag behavior**

1. When collapsed, drag the mascot to a new position
2. Expand → pane should appear centered (not anchored to mascot)
3. Close → mascot should return to the dragged position

- [ ] **Step 6: Fix any issues found**

Address bugs discovered during testing.

- [ ] **Step 7: Commit fixes (if any)**

```bash
git add -u
git commit -m "fix(copilot): address centered pane testing feedback"
```
