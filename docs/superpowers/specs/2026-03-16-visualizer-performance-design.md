# Visualizer Performance Optimization — Design Spec

**Date:** 2026-03-16
**Goal:** Reduce CPU usage of the space visualizer by 70-85% while preserving all visual effects.
**Approach:** Multi-canvas layered architecture + targeted render optimizations.

---

## 1. Multi-Canvas Layer Architecture

Replace the single `<canvas>` in `SpaceCanvas.tsx` with 3 stacked canvases inside the existing `relative` wrapper div.

### Layer Assignment

| Layer      | Ref               | Target FPS | Systems                                                    |
| ---------- | ----------------- | ---------- | ---------------------------------------------------------- |
| Background | `bgCanvasRef`     | 10         | background fill, aurora, nebula                            |
| Mid        | `midCanvasRef`    | 30         | starfield, shooting stars, celestials, asteroids           |
| Active     | `activeCanvasRef` | 30         | ships, particles, bloom glow, space weather, engine trails |

### DOM Structure

```tsx
<div className="relative w-full h-full">
  <canvas
    ref={bgCanvasRef}
    className="absolute inset-0 w-full h-full"
    style={{ imageRendering: 'pixelated', pointerEvents: 'none' }}
  />
  <canvas
    ref={midCanvasRef}
    className="absolute inset-0 w-full h-full"
    style={{ imageRendering: 'pixelated', pointerEvents: 'none' }}
  />
  <canvas
    ref={activeCanvasRef}
    className="absolute inset-0 w-full h-full cursor-pointer"
    style={{ imageRendering: 'pixelated' }}
  />
  {tooltip && <TooltipOverlay />}
</div>
```

### Pointer Events

Only `activeCanvasRef` (topmost) receives click, double-click, mouse move, mouse leave, and wheel events. Lower canvases have `pointer-events: none`.

### Camera Sync

The camera lerp (`camera.x += (targetX - x) * 0.05`) runs in the active layer's loop. Background and mid loops read the same shared `cameraRef` when they next render. Worst-case lag is ~133ms for the background layer (100ms interval + 33ms active loop delay). This is imperceptible on slow-drifting ambient elements.

### Canvas Resize

A single `ResizeObserver` on the wrapper div (or size detection in the active loop) updates all 3 canvas dimensions. Background and mid loops detect size changes at their next frame to re-render at the correct resolution. Note: resizing a canvas clears its contents, so each loop must redraw after resize.

### DPR

All 3 canvases cap `devicePixelRatio` at 1.0. The scene uses `imageRendering: pixelated`, so Retina resolution adds zero visual benefit. This alone reduces pixel fill by 75% on 2x displays.

---

## 2. Frame Rate Control

Each layer gets its own `requestAnimationFrame` loop with a delta-time accumulator.

### Pattern

```ts
const INTERVAL = 1000 / targetFps;
let accumulated = 0;

function loop(timestamp: number) {
  const delta = timestamp - lastTime;
  lastTime = timestamp;
  accumulated += delta;

  if (accumulated >= INTERVAL) {
    update(accumulated);
    render();
    accumulated %= INTERVAL; // preserve remainder to prevent drift
  }

  animFrame = requestAnimationFrame(loop);
}
```

Still uses `requestAnimationFrame` so the browser auto-pauses in background tabs. Skips render work when not enough time has elapsed. The `accumulated` value is passed to update functions so physics stays correct.

### Target Rates

- Background: 10fps (100ms interval)
- Mid: 30fps (~33ms interval)
- Active: 30fps (~33ms interval)

### Visibility Pausing

Add a `document.visibilitychange` listener. When `document.visibilityState === 'hidden'`, cancel all 3 animation frames. On resume, reset `lastTime` to prevent a huge delta spike.

### Impact

On a 60Hz Retina display: active layer goes from 60fps at 4x pixels to 30fps at 1x pixels — ~8x reduction in pixel fill. Background layer drops from 60fps to 10fps — 6x reduction.

---

## 3. Starfield Optimizations

### 3a: Eliminate per-frame `ctx.filter = 'blur(1px)'`

**Problem:** The far layer (layer 0, speed 5px/s) applies a CSS blur filter to every individual `fillRect` — ~10 blurred draw ops per frame. This is the single most expensive operation in the pipeline. Canvas 2D filters trigger Chromium's Skia software rasterization path.

**Fix:** Pre-render all far-layer stars onto a dedicated `OffscreenCanvas` with the blur applied once. On each frame, `drawImage` the cached buffer with an X-offset for parallax scroll. The buffer is drawn in world-space after the camera transform — at position `(0, 0)` in world coordinates, scrolled left by `star.x` drift. The mid-layer canvas applies the full camera transform (`ctx.translate(-camera.x, -camera.y)`) before rendering, just like the current single-canvas code. Re-render the OffscreenCanvas only when:

- A star wraps around (respawns off the right edge)
- The starfield resizes

The blur cost drops from ~10 filtered draws per frame to ~1 filtered full-buffer draw every few seconds.

### 3b: Cache constellation edges

**Problem:** `renderConstellations()` runs O(n²) distance checks with `Math.sqrt` on ~20 mid-layer stars every frame (190 sqrt calls + per-line `beginPath/stroke`).

**Fix:**

1. Compare `dx*dx + dy*dy < 1600` instead of `Math.sqrt(dx*dx + dy*dy) < 40`
2. Cache edge list as `Array<[number, number]>` index pairs. Recompute on a 500ms timer (stars drift continuously, so wrap-only invalidation would miss edges forming between converging stars or retain stale edges between diverging ones). At 500ms intervals, the visual difference is imperceptible given the 0.05 alpha line opacity.
3. Batch all constellation lines into a single `beginPath()` → N × `moveTo/lineTo` → one `stroke()`.

Result: 0 sqrts + 1 stroke on most frames.

### 3c: Pre-compute star fillStyle strings

**Problem:** Every star creates an `rgba(R, G, B, alpha)` template string per frame (~60 string allocations).

**Fix:**

- Non-twinkling stars (~70%): Cache the `rgba()` string on the Star object at creation time.
- Twinkling stars (~30%): Quantize alpha to 20 discrete levels. Maintain a lookup table of pre-built strings (5 star colors × 20 alpha levels = 100 strings total).

---

## 4. Aurora Caching

**Problem:** `aurora.ts` creates 2-3 `LinearGradient` objects with `hsla()` color stops every frame. Hue shifts at 2 degrees/second — imperceptible between frames.

**Fix:** Render each aurora band to its own small `OffscreenCanvas` (full width × band height). Cache it and re-render only when hue shifts by ≥5 degrees (~2.5 seconds). On each frame, just `drawImage` at the oscillated Y position with `globalAlpha`.

### Nebula — No Changes Needed

Already uses pre-rendered `OffscreenCanvas` textures (200×120px). Benefits from moving to the background layer at 10fps (6x fewer draws).

---

## 5. Minor Cleanups

### 5a: Particle in-place compaction

Replace `this.particles = this.particles.filter(...)` in `ParticleSystem` and `SpaceWeather` with in-place compaction: iterate with a write pointer, copy surviving elements forward, then set `this.particles.length = writeIdx`. For spawn-at-capacity in `ParticleSystem`, overwrite index 0 (the oldest particle after compaction) instead of calling `shift()` (which is O(n)). This works because compaction runs before spawn in the frame lifecycle (update → spawn), so index 0 is always the oldest surviving particle. Reduces GC pressure.

### 5b: Ship sort array reuse

Replace `[...ships].sort(...)` in `space-renderer.ts` with a persistent `sortBuffer: Ship[]` that gets reused each frame. The sort itself (Timsort, N<20) is fine — just eliminate the spread allocation.

### 5c: Bloom fallback removal

The fallback path in `bloom.ts` `render()` reads back the entire canvas with `ctx.canvas` to create a full-scene blur. In the multi-canvas architecture, this would only capture the active layer (ships/particles), producing a broken visual. Since sprites are bundled with the app and `isSpriteReady()` returns true almost immediately after load, the fallback path is effectively dead code. Remove the fallback `render()` method entirely and the associated OffscreenCanvas buffer. The sprite-based `renderShipGlow()` path is already efficient and sufficient.

### 5d: No changes to these systems

- **Space weather:** Conditional (3+ working agents). Lightweight.
- **Asteroids:** Conditional (needs-permission state). Lightweight.
- **Shooting stars:** Simple draws. Benefits from 30fps mid-layer cap.

---

## Files Modified

| File                | Change                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `SpaceCanvas.tsx`   | Restructure to 3 canvases, 3 loops, DPR cap, visibility pausing, shared resize observer              |
| `starfield.ts`      | Far-layer OffscreenCanvas cache, constellation edge caching (500ms timer), fillStyle pre-computation |
| `aurora.ts`         | OffscreenCanvas band caching with hue-based invalidation                                             |
| `bloom.ts`          | Remove fallback `render()` method and its OffscreenCanvas buffer                                     |
| `space-renderer.ts` | Reusable sort buffer                                                                                 |
| `particles.ts`      | In-place compaction, replace shift() with index-0 overwrite                                          |
| `space-weather.ts`  | In-place compaction                                                                                  |

No new files created. No systems removed.

---

## Expected Impact

| Metric                      | Before       | After               |
| --------------------------- | ------------ | ------------------- |
| Frame rate (active layer)   | 60fps        | 30fps               |
| Frame rate (background)     | 60fps        | 10fps               |
| Canvas DPR                  | 2.0 (Retina) | 1.0                 |
| Pixel fill per frame        | 4x           | 1x                  |
| Far-layer blur ops/frame    | ~10          | 0 (cached)          |
| Constellation sqrt/frame    | ~190         | 0 (cached)          |
| String allocs/frame (stars) | ~60          | ~6 (twinklers only) |
| Estimated CPU reduction     | —            | 70-85%              |
