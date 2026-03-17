# Star Command Scene Sidebar

**Date:** 2026-03-17
**Status:** Approved

## Overview

Replace the Star Command status sidebar with a full space scene canvas. The scene displays the rotating station hub, sector ring, crew pods, and comms beams — driven entirely by live Star Command store data. No text lists.

## Layout Change

`StarCommandTab` layout changes from:
```
[CrtFrame chat panel] [StatusPanel w-72]
```
to:
```
[CrtFrame chat panel] [StarCommandScene flex-1]
```

The `StatusPanel` component is removed entirely. The `statusPanelOpen` state, `toggleStatusPanel` action, and the "Show/Hide Status" header button are all removed. `StarCommandScene` fills all remaining horizontal space at full height.

## StarCommandScene Component

**File:** `src/renderer/src/components/star-command/StarCommandScene.tsx`

A single `<canvas>` that fills its container. A `ResizeObserver` keeps the canvas dimensions in sync with the container. A 30fps throttled RAF loop drives all rendering.

### Per-Frame Loop Order

Each frame (30fps cap):

1. Compute `deltaMs` from last frame timestamp
2. `commsBeams.clearPositions()` — purge stale positions before re-registering (ring rotates every frame so positions change)
3. `stationRing.update(sectorStates, deltaMs)`
4. `crewPods.update(podStates, deltaMs)`
5. `commsBeams.update(deltaMs)` — advance orb progress, prune dead beams
6. Register positions: `commsBeams.setPosition('hub', cx, cy)` + one `setPosition(crewId, px, py)` per pod using the same position math as `CrewPodRenderer`
7. Render layers back to front (see below)
8. Spawn new beams if the 3s interval has elapsed for hailing crew

### Rendering Layers (back to front)

1. **Background** — solid deep navy fill (`#0a0a1a`)
2. **Starfield** — ~150 static star dots distributed across the canvas at init. Each star has a random `phase` offset. Brightness twinkles via `0.4 + 0.6 * Math.abs(sin(elapsed * speed + phase))`. Implemented inline — no external dependency.
3. **StationRing** — existing `StationRing` class from `visualizer/station-ring.ts`, centered at `(cx, cy)`. Slowly rotates, arcs lit teal for active sectors, dim for inactive.
4. **CrewPodRenderer** — existing `CrewPodRenderer` class from `visualizer/crew-pods.ts`. Pods placed on the ring arcs, status-driven glow colors and pulse animations.
5. **CommsBeams** — existing `CommsBeamRenderer` from `visualizer/comms-beams.ts`. Beams spawn periodically (~3s interval) from each hailing crewmate's pod position toward the hub center. Purely visual — no store state needed.
6. **StationHub sprite** — `ctx.imageSmoothingEnabled = false` set immediately before the draw call each frame. Drawn via `drawScSprite(ctx, 'station-hub', elapsed, cx - 64, cy - 64, 128, 128)`. Only drawn when `isScSpriteReady()` is true; all other layers render regardless.

### Canvas Center

The station hub and ring are always centered at `(canvas.width / 2, canvas.height / 2)`.

### Data Mapping

From `useStarCommandStore`:

**Sectors → `SectorState[]`**
```ts
sectors.map(s => ({
  id: s.id,
  name: s.name,
  active: crewList.some(c => c.sector_id === s.id && c.status === 'active'),
}))
```

**Crew → `PodState[]`**
```ts
crewList.map(c => ({
  crewId: c.id,
  sectorId: c.sector_id,
  status: (c.status as PodState['status']) ?? 'idle',
}))
```
`c.status` is `string` in the store; cast to `PodState['status']` union with `'idle'` fallback for unrecognised values.

**Comms beams** — a `lastBeamSpawn` ref (timestamp) is checked inside the RAF loop at step 8. If `elapsed - lastBeamSpawn >= 3000`, iterate hailing crew and call `commsBeams.addBeam(c.id, 'hub', '#14b8a6')`, then update `lastBeamSpawn`. Spawning is always synchronous with step 6 (position registration), so every new beam immediately has a valid `from` position on its first rendered frame.

### Sprite Sheet

`StarCommandScene` calls `loadScSpriteSheet()` on mount (idempotent — safe to call multiple times). The existing `useEffect(() => { loadScSpriteSheet() }, [])` in `StarCommandTab` is **removed** as part of this change since `StarCommandScene` owns the call. The scene checks `isScSpriteReady()` before drawing the hub sprite each frame — renders all other layers regardless.

### Responsive Scaling

The scene applies a uniform scale factor based on `Math.min(canvas.width, canvas.height)` so the ring and hub remain proportional at any panel size. `StarCommandScene` has `min-w-[280px]` to prevent the panel collapsing too narrow. At very small sizes (canvas < 280px wide) the ring labels may overlap — acceptable edge case.

### Performance

#### Adaptive frame rate
Two speed modes driven by a `mode` ref checked at the top of every RAF callback:

| Mode | FPS | Condition |
|------|-----|-----------|
| `idle` | 10fps (`>= 100ms`) | No active/hailing crew and no beams in flight |
| `active` | 30fps (`>= 33ms`) | Any active/hailing crew or beams in flight |

The mode is re-evaluated once per frame. This means the loop runs at 10fps when nobody is deployed — the ring and hub still animate, just at low cost.

#### Full pause when hidden
The RAF loop stops entirely (no `requestAnimationFrame` call) in two cases:
- `document.visibilitychange` fires with `document.hidden === true`
- Electron's `BrowserWindow` emits `hide` or `minimize` (forwarded to renderer via existing IPC or `window.addEventListener('blur')` as a proxy)

On becoming visible again, the loop resumes from the current `performance.now()` timestamp to avoid a large `deltaMs` spike.

#### Offscreen star canvas
Stars are pre-rendered to a secondary `OffscreenCanvas` (same size as the main canvas). The offscreen canvas is redrawn at a fixed **5fps** (`>= 200ms` between star redraws). Every main-canvas frame simply blits it via `ctx.drawImage(starOffscreen, 0, 0)`. Since stars twinkle slowly, 5fps updates are imperceptible. On canvas resize, the offscreen canvas is resized and the star positions are re-scattered.

#### Opaque canvas context
The 2d context is acquired with `{ alpha: false }`. Since the background is always a solid fill, the browser skips alpha compositing for this canvas layer — a free GPU win.

#### Store data in refs, not React state
`sectorStatesRef` and `podStatesRef` are `useRef` values updated by a `useEffect` that subscribes to `useStarCommandStore`. The RAF loop reads from refs directly. This means store updates (crew status changes, new sectors) never trigger a React re-render of the component — only the ref values change, and the next RAF frame picks them up.

#### ResizeObserver debounce
Canvas dimensions are only updated on the next `requestAnimationFrame` after a resize event fires, not synchronously in the observer callback. This coalesces rapid resize events (e.g. window drag) into a single resize per frame.

## Files Changed

| File | Change |
|------|--------|
| `src/renderer/src/components/StarCommandTab.tsx` | Remove `StatusPanel`, `statusPanelOpen`, `toggleStatusPanel`, "Show/Hide Status" button; add `<StarCommandScene className="flex-1 min-w-0" />` |
| `src/renderer/src/components/star-command/StarCommandScene.tsx` | New file |
