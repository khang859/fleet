# Star Command Scene Sidebar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Star Command status sidebar with a full-screen canvas space scene showing the rotating station hub, sector ring, crew pods, and comms beams.

**Architecture:** A new `StarCommandScene` React component owns a single `<canvas>` that fills all remaining horizontal space in the Star Command tab. Three existing renderer classes (`StationRing`, `CrewPodRenderer`, `CommsBeamRenderer`) are reused directly. Store data flows into `useRef` values read each frame — no React re-renders on data change. An offscreen canvas handles the starfield at 5fps; the main loop runs at 10fps (idle) or 30fps (active crew).

**Tech Stack:** React, TypeScript, Canvas 2D API, OffscreenCanvas, Vitest, existing `visualizer/` renderer classes, `sc-sprite-loader` for the station hub sprite.

---

## File Map

| File                                                                     | Action | Responsibility                                                                     |
| ------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------- |
| `src/renderer/src/components/StarCommandTab.tsx`                         | Modify | Remove StatusPanel, statusPanelOpen, loadScSpriteSheet; add `<StarCommandScene />` |
| `src/renderer/src/store/star-command-store.ts`                           | Modify | Remove `statusPanelOpen` state and `toggleStatusPanel` action                      |
| `src/renderer/src/components/star-command/StarCommandScene.tsx`          | Create | Full canvas scene component                                                        |
| `src/renderer/src/components/star-command/scene-utils.ts`                | Create | Pure data-mapping helpers (testable)                                               |
| `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts` | Create | Unit tests for mapping helpers                                                     |

---

### Task 1: Remove StatusPanel from StarCommandTab and store

**Files:**

- Modify: `src/renderer/src/components/StarCommandTab.tsx`
- Modify: `src/renderer/src/store/star-command-store.ts`

- [ ] **Step 1: Remove `statusPanelOpen` and `toggleStatusPanel` from the store**

In `src/renderer/src/store/star-command-store.ts`, delete:

- The `statusPanelOpen: boolean` field from `StarCommandStore` type
- The `statusPanelOpen: true` initial value
- The `toggleStatusPanel: () => set(...)` action

- [ ] **Step 2: Clean up StarCommandTab**

In `src/renderer/src/components/StarCommandTab.tsx`:

1. Remove the import of `loadScSpriteSheet` (will move to StarCommandScene)
2. Remove `StatusPanel` function component entirely (lines ~77–171)
3. In `StarCommandTab`, remove from the destructured store values:
   - `toggleStatusPanel`
   - `statusPanelOpen`
4. Remove the `useEffect(() => { loadScSpriteSheet() }, [])` line
5. Remove the "Show Status / Hide Status" `<button>` in the header
6. Replace `<StatusPanel />` at the bottom of the JSX with a temporary placeholder:
   ```tsx
   <div className="flex-1 min-w-[280px] bg-[#0a0a1a]" />
   ```
7. Remove the outer `<div className="h-full flex">` wrapper's `StatusPanel` sibling — the placeholder div is now the sibling of `<CrtFrame>`

The final JSX structure of the return should be:

```tsx
return (
  <div className="h-full flex">
    <CrtFrame>{/* existing chat content unchanged */}</CrtFrame>
    <div className="flex-1 min-w-[280px] bg-[#0a0a1a]" />
  </div>
);
```

- [ ] **Step 3: Verify the app compiles**

```bash
npm run typecheck:web 2>&1 | grep -v "^>" | grep -i "error" | grep -v "StarCommandTab\|star-command-store" | head -20
```

Expected: only pre-existing unrelated errors (none in the files we touched).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/StarCommandTab.tsx src/renderer/src/store/star-command-store.ts
git commit -m "feat(star-command): remove StatusPanel, add scene placeholder"
```

---

### Task 2: Create `scene-utils.ts` with data-mapping helpers and tests

**Files:**

- Create: `src/renderer/src/components/star-command/scene-utils.ts`
- Create: `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts`

These are pure functions — no React, no canvas. Test them first.

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapSectors, mapCrew } from '../scene-utils';
import type { SectorInfo, CrewStatus } from '../../../store/star-command-store';

const makeSector = (id: string, name = id): SectorInfo => ({
  id,
  name,
  root_path: '/tmp',
  stack: null
});
const makeCrew = (id: string, sector_id: string, status: string): CrewStatus => ({
  id,
  sector_id,
  status,
  mission_summary: null,
  tab_id: null,
  avatar_variant: null,
  created_at: ''
});

describe('mapSectors', () => {
  it('marks sector active when any crew in it is active', () => {
    const sectors = [makeSector('api'), makeSector('web')];
    const crew = [makeCrew('c1', 'api', 'active')];
    const result = mapSectors(sectors, crew);
    expect(result.find((s) => s.id === 'api')?.active).toBe(true);
    expect(result.find((s) => s.id === 'web')?.active).toBe(false);
  });

  it('returns empty array for empty sectors', () => {
    expect(mapSectors([], [])).toEqual([]);
  });

  it('marks sector inactive when crew status is not active', () => {
    const sectors = [makeSector('api')];
    const crew = [makeCrew('c1', 'api', 'hailing')];
    const result = mapSectors(sectors, crew);
    expect(result[0].active).toBe(false);
  });
});

describe('mapCrew', () => {
  it('maps crew to pod states with correct fields', () => {
    const crew = [makeCrew('c1', 'api', 'active')];
    const result = mapCrew(crew);
    expect(result).toEqual([{ crewId: 'c1', sectorId: 'api', status: 'active' }]);
  });

  it('falls back to idle for unknown status', () => {
    const crew = [makeCrew('c1', 'api', 'unknown-status')];
    const result = mapCrew(crew);
    expect(result[0].status).toBe('idle');
  });

  it('returns empty array for empty crew', () => {
    expect(mapCrew([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run src/renderer/src/components/star-command/__tests__/scene-utils.test.ts 2>&1 | tail -10
```

Expected: FAIL — `scene-utils` module not found.

- [ ] **Step 3: Implement `scene-utils.ts`**

Create `src/renderer/src/components/star-command/scene-utils.ts`:

```ts
import type { SectorInfo, CrewStatus } from '../../store/star-command-store';
import type { SectorState } from '../../components/visualizer/station-ring';
import type { PodState } from '../../components/visualizer/crew-pods';

const VALID_POD_STATUSES = new Set<string>([
  'active',
  'hailing',
  'error',
  'complete',
  'lost',
  'idle'
]);

export function mapSectors(sectors: SectorInfo[], crew: CrewStatus[]): SectorState[] {
  return sectors.map((s) => ({
    id: s.id,
    name: s.name,
    active: crew.some((c) => c.sector_id === s.id && c.status === 'active')
  }));
}

export function mapCrew(crew: CrewStatus[]): PodState[] {
  return crew.map((c) => ({
    crewId: c.id,
    sectorId: c.sector_id,
    status: (VALID_POD_STATUSES.has(c.status) ? c.status : 'idle') as PodState['status']
  }));
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run src/renderer/src/components/star-command/__tests__/scene-utils.test.ts 2>&1 | tail -10
```

Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/star-command/scene-utils.ts src/renderer/src/components/star-command/__tests__/scene-utils.test.ts
git commit -m "feat(star-command): add scene-utils data mapping helpers with tests"
```

---

### Task 3: StarCommandScene skeleton — canvas, ResizeObserver, background

**Files:**

- Create: `src/renderer/src/components/star-command/StarCommandScene.tsx`

- [ ] **Step 1: Create the component**

Create `src/renderer/src/components/star-command/StarCommandScene.tsx`:

```tsx
import { useRef, useEffect } from 'react';

export function StarCommandScene({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const pendingResizeRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Sync canvas size to container
    const applyResize = () => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      pendingResizeRef.current = false;
    };
    applyResize();

    const ro = new ResizeObserver(() => {
      // Debounce: apply resize on next RAF tick
      pendingResizeRef.current = true;
    });
    ro.observe(container);

    let stopped = false;

    function frame(now: number) {
      if (stopped) return;

      // Apply pending resize
      if (pendingResizeRef.current) applyResize();

      const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16;
      lastFrameRef.current = now;

      const w = canvas!.width;
      const h = canvas!.height;

      // Background
      ctx!.fillStyle = '#0a0a1a';
      ctx!.fillRect(0, 0, w, h);

      // TODO: layers will be added in subsequent tasks

      rafRef.current = requestAnimationFrame(frame);
    }

    const handleVisibility = () => {
      if (document.hidden) {
        stopped = true;
        cancelAnimationFrame(rafRef.current);
      } else {
        stopped = false;
        lastFrameRef.current = 0; // reset to avoid deltaMs spike
        rafRef.current = requestAnimationFrame(frame);
      }
    };
    const handleBlur = () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
    };
    const handleFocus = () => {
      if (!stopped) return;
      stopped = false;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(frame);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);

    rafRef.current = requestAnimationFrame(frame);

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
```

- [ ] **Step 2: Wire into StarCommandTab**

In `src/renderer/src/components/StarCommandTab.tsx`:

1. Add import: `import { StarCommandScene } from './star-command/StarCommandScene'`
2. Replace the placeholder div:
   ```tsx
   // Remove:
   <div className="flex-1 min-w-[280px] bg-[#0a0a1a]" />
   // Add:
   <StarCommandScene className="flex-1 min-w-[280px]" />
   ```

- [ ] **Step 3: Verify the app compiles and shows a dark panel**

```bash
npm run typecheck:web 2>&1 | grep "StarCommandScene\|scene-utils" | head -5
```

Expected: no errors in our new files. Open the app and confirm the right side of Star Command is solid dark navy.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx src/renderer/src/components/StarCommandTab.tsx
git commit -m "feat(star-command): add StarCommandScene canvas skeleton"
```

---

### Task 4: Starfield layer

**Files:**

- Modify: `src/renderer/src/components/star-command/StarCommandScene.tsx`

- [ ] **Step 1: Add star types and initialization at the top of the useEffect**

Inside the `useEffect`, after `applyResize()`, add:

```ts
// --- Starfield ---
type Star = { x: number; y: number; radius: number; phase: number; speed: number };

const STAR_COUNT = 150;
let stars: Star[] = [];

const scatterStars = (w: number, h: number) => {
  stars = Array.from({ length: STAR_COUNT }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    radius: Math.random() * 1.2 + 0.3,
    phase: Math.random() * Math.PI * 2,
    speed: Math.random() * 0.0008 + 0.0002
  }));
};
scatterStars(canvas.width, canvas.height);

// Offscreen canvas for stars (redrawn at 5fps)
let starOffscreen = new OffscreenCanvas(canvas.width, canvas.height);
let starCtx = starOffscreen.getContext('2d')!;
let lastStarRedraw = 0;
let elapsed = 0;

const redrawStars = () => {
  starCtx.clearRect(0, 0, starOffscreen.width, starOffscreen.height);
  for (const star of stars) {
    const brightness = 0.4 + 0.6 * Math.abs(Math.sin(elapsed * star.speed + star.phase));
    starCtx.beginPath();
    starCtx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    starCtx.fillStyle = `rgba(255,255,255,${brightness.toFixed(2)})`;
    starCtx.fill();
  }
};
redrawStars();
```

- [ ] **Step 2: Update `applyResize` to also resize the offscreen canvas**

Modify the existing `applyResize` function to add at the end:

```ts
const applyResize = () => {
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  pendingResizeRef.current = false;
  // Resize offscreen canvas and re-scatter stars
  if (typeof starOffscreen !== 'undefined') {
    starOffscreen = new OffscreenCanvas(canvas.width, canvas.height);
    starCtx = starOffscreen.getContext('2d')!;
    scatterStars(canvas.width, canvas.height);
    redrawStars();
  }
};
```

Note: Because `starOffscreen` is declared with `let` after `applyResize`, restructure so `applyResize` is defined after the star declarations. Move the initial `applyResize()` call to after the star declarations.

- [ ] **Step 3: Add elapsed tracking and star blit to the frame loop**

In the `frame` function, after `lastFrameRef.current = now`, add `elapsed += deltaMs`.

After the background fill, add:

```ts
// Starfield — redraw offscreen at 5fps, blit every frame
if (now - lastStarRedraw >= 200) {
  redrawStars();
  lastStarRedraw = now;
}
ctx!.drawImage(starOffscreen, 0, 0);
```

- [ ] **Step 4: Verify stars appear and twinkle**

Open the app. The dark panel should now show ~150 small white dots that slowly change brightness.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx
git commit -m "feat(star-command): add twinkling starfield layer to scene"
```

---

### Task 5: Station ring + crew pods

**Files:**

- Modify: `src/renderer/src/components/star-command/StarCommandScene.tsx`

- [ ] **Step 1: Add imports at the top of the file**

```tsx
import { useRef, useEffect } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import { StationRing } from '../visualizer/station-ring';
import { CrewPodRenderer } from '../visualizer/crew-pods';
import { mapSectors, mapCrew } from './scene-utils';
import type { SectorState } from '../visualizer/station-ring';
import type { PodState } from '../visualizer/crew-pods';
```

- [ ] **Step 2: Add store subscription refs inside the component (above `useEffect`)**

```tsx
const sectorStatesRef = useRef<SectorState[]>([]);
const podStatesRef = useRef<PodState[]>([]);

// Sync store data into refs without causing re-renders
const { sectors, crewList } = useStarCommandStore();
useEffect(() => {
  sectorStatesRef.current = mapSectors(sectors, crewList);
  podStatesRef.current = mapCrew(crewList);
}, [sectors, crewList]);
```

- [ ] **Step 3: Instantiate renderers inside the main `useEffect` (after star declarations)**

```ts
const stationRing = new StationRing();
const crewPods = new CrewPodRenderer();
```

- [ ] **Step 4: Compute scale and center, add ring+pod update/render to frame loop**

In the `frame` function, after star blit, add:

```ts
const cx = w / 2;
const cy = h / 2;
const scale = Math.min(w, h) / 600; // 600 is reference size

const sectors = sectorStatesRef.current;
const pods = podStatesRef.current;

stationRing.update(sectors, deltaMs);
crewPods.update(pods, deltaMs);

// Scale context for ring and pods
ctx!.save();
ctx!.translate(cx, cy);
ctx!.scale(scale, scale);
ctx!.translate(-cx, -cy);
stationRing.render(ctx!, cx, cy);
crewPods.render(ctx!, cx, cy, stationRing);
ctx!.restore();
```

- [ ] **Step 5: Verify ring renders**

Open the app. With no sectors registered, the ring should not render (StationRing returns early if `sectors.length === 0`). To test: open Star Command Config, add a sector — a teal arc should appear around the center of the scene. With active crew the arc lights up.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx
git commit -m "feat(star-command): add station ring and crew pods to scene"
```

---

### Task 6: Station hub sprite

**Files:**

- Modify: `src/renderer/src/components/star-command/StarCommandScene.tsx`

- [ ] **Step 1: Add sprite imports**

```tsx
import { loadScSpriteSheet, isScSpriteReady, drawScSprite } from './sc-sprite-loader';
```

- [ ] **Step 2: Load sprite sheet on mount**

At the very start of the main `useEffect` body, add:

```ts
loadScSpriteSheet();
```

- [ ] **Step 3: Draw station hub in frame loop**

After the ring/pod render block, add:

```ts
// Station hub sprite (centered, drawn on top of ring)
if (isScSpriteReady()) {
  const hubSize = 128 * scale;
  ctx!.imageSmoothingEnabled = false;
  drawScSprite(ctx!, 'station-hub', elapsed, cx - hubSize / 2, cy - hubSize / 2, hubSize, hubSize);
}
```

- [ ] **Step 4: Verify hub renders**

Open the app. The station hub pixel art should appear rotating at the center of the scene. The ring arcs should be visible around it.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx
git commit -m "feat(star-command): add rotating station hub sprite to scene"
```

---

### Task 7: Comms beams

**Files:**

- Modify: `src/renderer/src/components/star-command/StarCommandScene.tsx`

- [ ] **Step 1: Add import**

```tsx
import { CommsBeamRenderer } from '../visualizer/comms-beams';
```

- [ ] **Step 2: Instantiate and add refs inside the main `useEffect`**

After `const crewPods = new CrewPodRenderer()`, add:

```ts
const commsBeams = new CommsBeamRenderer();
let lastBeamSpawn = 0;
```

- [ ] **Step 3: Register positions and update beams in frame loop**

In the `frame` function, after `crewPods.update(pods, deltaMs)` and before `ctx!.save()`, add:

```ts
// Register positions for comms beams
commsBeams.clearPositions();
commsBeams.setPosition('hub', cx, cy);

// Compute pod positions (same math as CrewPodRenderer)
const RING_RADIUS = 120 * scale;
const POD_OFFSET = 4 * scale;
const podRadius = RING_RADIUS - POD_OFFSET;
const sectorCount = sectors.length;
if (sectorCount > 0) {
  const gapRad = (2 * Math.PI) / 180;
  const totalGap = gapRad * sectorCount;
  const arcPerSector = (Math.PI * 2 - totalGap) / sectorCount;
  const podsBySector = new Map<string, PodState[]>();
  for (const pod of pods) {
    const list = podsBySector.get(pod.sectorId) ?? [];
    list.push(pod);
    podsBySector.set(pod.sectorId, list);
  }
  let angle = stationRing['rotation'] as number; // read private field
  for (const sector of sectors) {
    const sectorPods = podsBySector.get(sector.id) ?? [];
    const count = sectorPods.length;
    const endAngle = angle + arcPerSector;
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const podAngle = angle + arcPerSector * (0.15 + t * 0.7);
      const px = cx + Math.cos(podAngle) * podRadius;
      const py = cy + Math.sin(podAngle) * podRadius;
      commsBeams.setPosition(sectorPods[i].crewId, px, py);
    }
    angle = endAngle + gapRad;
  }
}

commsBeams.update(deltaMs);
```

- [ ] **Step 4: Spawn beams and render them**

After the position registration block, add beam spawning (still before `ctx.save()`):

```ts
// Spawn beams for hailing crew every 3 seconds
if (elapsed - lastBeamSpawn >= 3000) {
  for (const pod of pods) {
    if (pod.status === 'hailing') {
      commsBeams.addBeam(pod.crewId, 'hub', '#14b8a6');
    }
  }
  lastBeamSpawn = elapsed;
}
```

After `ctx.restore()` (after ring/pod render), add:

```ts
commsBeams.render(ctx!, cx, cy);
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx
git commit -m "feat(star-command): add comms beams to scene"
```

---

### Task 8: Adaptive frame rate

**Files:**

- Modify: `src/renderer/src/components/star-command/StarCommandScene.tsx`

- [ ] **Step 1: Add mode ref and FPS throttle to frame loop**

At the top of the `frame` function body, replace the existing `deltaMs` line with:

```ts
// Determine frame budget based on activity
const hasActiveCrew = podStatesRef.current.some(
  (p) => p.status === 'active' || p.status === 'hailing'
);
const hasBeams = commsBeams['beams'].length > 0; // read private field
const isActive = hasActiveCrew || hasBeams;
const frameBudget = isActive ? 33 : 100; // 30fps vs 10fps

if (now - lastFrameRef.current < frameBudget) {
  rafRef.current = requestAnimationFrame(frame);
  return;
}

const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16;
lastFrameRef.current = now;
```

- [ ] **Step 2: Verify adaptive rate**

With no crew: open DevTools Performance tab, record 5 seconds. Confirm the canvas `frame` function fires ~10 times/second. Set a crew status to `active` in the store (dev tools or by deploying a crew) — confirm it jumps to ~30fps.

- [ ] **Step 3: Final typecheck**

```bash
npm run typecheck:web 2>&1 | grep "StarCommandScene\|scene-utils\|SceneUtils" | head -10
```

Expected: no errors in our files.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx
git commit -m "feat(star-command): adaptive FPS (10fps idle, 30fps active)"
```

---

## Acceptance Checklist

- [ ] Dark navy panel fills all space to the right of the CRT chat frame
- [ ] ~150 stars visible, gently twinkling
- [ ] Station hub sprite rotates slowly at center
- [ ] Station ring arcs appear around hub when sectors are registered
- [ ] Arc color is teal for sectors with active crew, dim for inactive
- [ ] Crew pods appear on ring arcs, glow color matches status
- [ ] Hailing crew pods trigger teal comms beams traveling to hub every 3s
- [ ] No status sidebar or Show/Hide button anywhere in the UI
- [ ] Scene pauses when window loses focus or is hidden
- [ ] 10fps when no crew deployed; 30fps with active/hailing crew
- [ ] All 7 `scene-utils` unit tests pass
