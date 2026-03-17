# Visualizer Performance Optimization — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce CPU usage of the space visualizer by 70-85% while preserving all visual effects.

**Architecture:** Replace the single canvas with 3 stacked canvases (background at 10fps, mid at 30fps, active at 30fps). Cap DPR at 1.0. Eliminate expensive per-frame operations: `ctx.filter` blur, O(n²) constellation checks, per-star string allocations, per-frame gradient creation.

**Tech Stack:** React, TypeScript, Canvas 2D API, OffscreenCanvas, vitest

**Spec:** `docs/superpowers/specs/2026-03-16-visualizer-performance-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/renderer/src/components/visualizer/SpaceCanvas.tsx` | Modify | 3 stacked canvases, 3 fps-capped loops, DPR cap, visibility pausing, resize observer |
| `src/renderer/src/components/visualizer/starfield.ts` | Modify | Far-layer OffscreenCanvas cache, constellation edge caching, fillStyle pre-computation |
| `src/renderer/src/components/visualizer/aurora.ts` | Modify | OffscreenCanvas band caching with hue invalidation |
| `src/renderer/src/components/visualizer/bloom.ts` | Modify | Remove fallback render() and its OffscreenCanvas buffer |
| `src/renderer/src/components/visualizer/space-renderer.ts` | Modify | Reusable sort buffer |
| `src/renderer/src/components/visualizer/particles.ts` | Modify | In-place compaction, replace shift() |
| `src/renderer/src/components/visualizer/space-weather.ts` | Modify | In-place compaction |
| `src/renderer/src/components/visualizer/__tests__/starfield.test.ts` | Modify | Add constellation cache + fillStyle tests |
| `src/renderer/src/components/visualizer/__tests__/particles.test.ts` | Modify | Update cap test for in-place compaction |
| `src/renderer/src/components/visualizer/__tests__/aurora.test.ts` | Create | Aurora caching tests |

---

### Task 1: Starfield — Far-Layer OffscreenCanvas Cache

Eliminate the most expensive per-frame operation: `ctx.filter = 'blur(1px)'` applied to every far-layer star individually.

**Files:**
- Modify: `src/renderer/src/components/visualizer/starfield.ts:148-174` (render method)
- Test: `src/renderer/src/components/visualizer/__tests__/starfield.test.ts`

- [ ] **Step 1: Write failing test for far-layer caching**

In `__tests__/starfield.test.ts`, add:

```ts
it('caches far-layer stars in an OffscreenCanvas buffer', () => {
  const sf = new Starfield(200, 100);
  // The far-layer cache should exist after construction
  expect(sf.getFarLayerCache()).toBeInstanceOf(OffscreenCanvas);
});

it('does not regenerate far-layer cache when no stars wrap', () => {
  const sf = new Starfield(200, 100);
  const cache1 = sf.getFarLayerCache();

  // Small update — no stars should wrap at speed 5px/s in 16ms
  sf.update(16);
  const cache2 = sf.getFarLayerCache();

  expect(cache2).toBe(cache1); // same object reference
});

it('regenerates far-layer cache when a star wraps', () => {
  const sf = new Starfield(200, 100);
  const cache1 = sf.getFarLayerCache();

  // Force a far-layer star off-screen left so it wraps
  sf.getLayers()[0].stars[0].x = -10;
  sf.update(16);
  const cache2 = sf.getFarLayerCache();

  expect(cache2).not.toBe(cache1); // new buffer generated
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts`
Expected: FAIL — `getFarLayerCache` is not a function

- [ ] **Step 3: Implement far-layer OffscreenCanvas cache**

In `starfield.ts`:

1. Add private fields:
```ts
private farCache: OffscreenCanvas | null = null;
private farCacheDirty = true;
```

2. Add public accessor:
```ts
getFarLayerCache(): OffscreenCanvas | null { return this.farCache; }
```

3. In `update()`, when a far-layer star wraps (inside the `if (star.x < -5)` block for layer index 0), set `this.farCacheDirty = true`.

4. Add a private method to rebuild the cache:
```ts
private rebuildFarCache(): void {
  const w = this.width;
  const h = this.height;
  if (!this.farCache || this.farCache.width !== w || this.farCache.height !== h) {
    this.farCache = new OffscreenCanvas(w, h);
  }
  const ctx = this.farCache.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.filter = 'blur(1px)';
  const layer = this.layers[0];
  for (const star of layer.stars) {
    const alpha = Math.max(0, Math.min(1, star.brightness));
    ctx.fillStyle = star.cachedFillStyle ?? `rgba(${star.r}, ${star.g}, ${star.b}, ${alpha})`;
    ctx.fillRect(Math.round(star.x), Math.round(star.y), Math.round(star.size), Math.round(star.size));
  }
  ctx.filter = 'none';
  this.farCacheDirty = false;
}
```

5. In `render()`, replace the far-layer block (the `if (li === 0)` branch at lines 152-161) with:
```ts
if (li === 0) {
  if (this.farCacheDirty || !this.farCache) {
    this.rebuildFarCache();
  }
  if (this.farCache) {
    ctx.drawImage(this.farCache, 0, 0);
  }
  continue;
}
```

6. In `resize()`, set `this.farCacheDirty = true`.

7. In `initLayers()`, set `this.farCacheDirty = true` (already implicitly true from field initializer, but explicit is clearer).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/starfield.ts src/renderer/src/components/visualizer/__tests__/starfield.test.ts
git commit -m "perf(visualizer): cache far-layer starfield to OffscreenCanvas, eliminate per-frame blur filter"
```

---

### Task 2: Starfield — Constellation Edge Caching

Replace O(n²) per-frame distance checks + per-line stroke with cached edges recomputed on a 500ms timer.

**Files:**
- Modify: `src/renderer/src/components/visualizer/starfield.ts:176-197` (renderConstellations method)
- Test: `src/renderer/src/components/visualizer/__tests__/starfield.test.ts`

- [ ] **Step 1: Write failing test for constellation caching**

```ts
it('caches constellation edges and recomputes on timer', () => {
  const sf = new Starfield(200, 100);
  // Force mid-layer stars close together so edges form
  const midStars = sf.getLayers()[1].stars;
  if (midStars.length >= 2) {
    midStars[0].x = 50;
    midStars[0].y = 50;
    midStars[1].x = 55;
    midStars[1].y = 50;
  }

  // First update triggers edge computation
  sf.update(16);
  const edges1 = sf.getConstellationEdges();
  expect(edges1.length).toBeGreaterThan(0);

  // Second update within 500ms reuses cache
  sf.update(16);
  const edges2 = sf.getConstellationEdges();
  expect(edges2).toBe(edges1); // same array reference

  // Update past 500ms threshold triggers recompute
  sf.update(500);
  const edges3 = sf.getConstellationEdges();
  expect(edges3).not.toBe(edges1); // new array
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts`
Expected: FAIL — `getConstellationEdges` is not a function

- [ ] **Step 3: Implement constellation edge caching**

In `starfield.ts`:

1. Add private fields (initialize timer at threshold so first update triggers computation):
```ts
private constellationEdges: [number, number][] = [];
private constellationTimer = 500; // start at threshold to compute edges on first update
private readonly CONSTELLATION_INTERVAL = 500; // ms
```

2. Add public accessor:
```ts
getConstellationEdges(): [number, number][] { return this.constellationEdges; }
```

3. In `update()`, after moving stars, add:
```ts
this.constellationTimer += deltaMs;
if (this.constellationTimer >= this.CONSTELLATION_INTERVAL) {
  this.recomputeConstellationEdges();
  this.constellationTimer = 0;
}
```

4. Add private method:
```ts
private recomputeConstellationEdges(): void {
  const stars = this.layers[1]?.stars;
  if (!stars) { this.constellationEdges = []; return; }

  const edges: [number, number][] = [];
  const threshold = 1600; // 40^2
  for (let i = 0; i < stars.length; i++) {
    for (let j = i + 1; j < stars.length; j++) {
      const dx = stars[i].x - stars[j].x;
      const dy = stars[i].y - stars[j].y;
      if (dx * dx + dy * dy < threshold) {
        edges.push([i, j]);
      }
    }
  }
  this.constellationEdges = edges;
}
```

5. Replace `renderConstellations()` body:
```ts
renderConstellations(ctx: CanvasRenderingContext2D): void {
  const midLayer = this.layers[1];
  if (!midLayer || this.constellationEdges.length === 0) return;

  const stars = midLayer.stars;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (const [i, j] of this.constellationEdges) {
    ctx.moveTo(Math.round(stars[i].x), Math.round(stars[i].y));
    ctx.lineTo(Math.round(stars[j].x), Math.round(stars[j].y));
  }
  ctx.stroke();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/starfield.ts src/renderer/src/components/visualizer/__tests__/starfield.test.ts
git commit -m "perf(visualizer): cache constellation edges on 500ms timer, eliminate O(n²) per-frame checks"
```

---

### Task 3: Starfield — Pre-Compute fillStyle Strings

Eliminate ~60 per-frame `rgba()` template string allocations.

**Files:**
- Modify: `src/renderer/src/components/visualizer/starfield.ts` (Star type + render method)
- Test: `src/renderer/src/components/visualizer/__tests__/starfield.test.ts`

- [ ] **Step 1: Write failing test**

```ts
it('pre-computes cachedFillStyle for non-twinkling stars', () => {
  const sf = new Starfield(200, 100);
  const layers = sf.getLayers();

  for (const layer of layers) {
    for (const star of layer.stars) {
      if (star.twinkleSpeed === 0) {
        expect(star.cachedFillStyle).toBeDefined();
        expect(star.cachedFillStyle).toMatch(/^rgba\(/);
      }
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts`
Expected: FAIL — `cachedFillStyle` is undefined

- [ ] **Step 3: Implement fillStyle pre-computation**

In `starfield.ts`:

1. Add `cachedFillStyle?: string` to the `Star` type.

2. Build a lookup table at module level for twinkle stars:
```ts
const ALPHA_LEVELS = 20;
const fillStyleLUT: Map<string, string[]> = new Map();

function buildFillStyleLUT(): void {
  for (const [, r, g, b] of STAR_COLORS) {
    const key = `${r},${g},${b}`;
    if (fillStyleLUT.has(key)) continue;
    const levels: string[] = [];
    for (let i = 0; i <= ALPHA_LEVELS; i++) {
      const alpha = (i / ALPHA_LEVELS).toFixed(2);
      levels.push(`rgba(${r}, ${g}, ${b}, ${alpha})`);
    }
    fillStyleLUT.set(key, levels);
  }
}
buildFillStyleLUT();

function getTwinkleFillStyle(r: number, g: number, b: number, alpha: number): string {
  const key = `${r},${g},${b}`;
  const levels = fillStyleLUT.get(key);
  if (!levels) return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  const idx = Math.max(0, Math.min(ALPHA_LEVELS, Math.round(alpha * ALPHA_LEVELS)));
  return levels[idx];
}
```

3. In `initLayers()`, after creating each star, if `twinkleSpeed === 0`, set:
```ts
star.cachedFillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${(config.brightness + (Math.random() - 0.5) * 0.15).toFixed(2)})`;
```
(Use the star's actual brightness value.)

4. In `render()`, for non-far layers (li > 0), replace the fillStyle line:
```ts
// Before:
ctx.fillStyle = `rgba(${star.r}, ${star.g}, ${star.b}, ${alpha})`;

// After:
ctx.fillStyle = star.cachedFillStyle ?? getTwinkleFillStyle(star.r, star.g, star.b, alpha);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/starfield.ts src/renderer/src/components/visualizer/__tests__/starfield.test.ts
git commit -m "perf(visualizer): pre-compute star fillStyle strings, eliminate per-frame rgba() allocations"
```

---

### Task 4: Aurora — OffscreenCanvas Band Caching

Replace per-frame gradient creation with cached OffscreenCanvas bands invalidated on hue shift.

**Files:**
- Modify: `src/renderer/src/components/visualizer/aurora.ts`
- Create: `src/renderer/src/components/visualizer/__tests__/aurora.test.ts`

- [ ] **Step 1: Write failing test**

Create `__tests__/aurora.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AuroraBands } from '../aurora';

// Minimal mock CanvasRenderingContext2D for render() calls
function mockCtx(): CanvasRenderingContext2D {
  return {
    globalAlpha: 1,
    drawImage: () => {},
    // Add any other methods render() calls if needed
  } as unknown as CanvasRenderingContext2D;
}

describe('AuroraBands', () => {
  it('initializes 2-3 bands on first update', () => {
    const aurora = new AuroraBands();
    aurora.update(16);
    expect(aurora.getBandCount()).toBeGreaterThanOrEqual(2);
    expect(aurora.getBandCount()).toBeLessThanOrEqual(3);
  });

  it('caches band canvases and reuses them across frames', () => {
    const aurora = new AuroraBands();
    aurora.update(16);
    // Must call render() to trigger cache generation and increment cacheGeneration
    aurora.render(mockCtx(), 200, 100);
    const cache1 = aurora.getBandCacheGeneration();

    // Small update — hue shifts <5 degrees
    aurora.update(16);
    aurora.render(mockCtx(), 200, 100);
    const cache2 = aurora.getBandCacheGeneration();

    expect(cache2).toBe(cache1); // no regeneration
  });

  it('regenerates band cache after hue shifts ≥5 degrees', () => {
    const aurora = new AuroraBands();
    aurora.update(16);
    aurora.render(mockCtx(), 200, 100);
    const cache1 = aurora.getBandCacheGeneration();

    // At 2 deg/s, 2500ms = 5 degrees of hue shift
    aurora.update(2500);
    aurora.render(mockCtx(), 200, 100);
    const cache2 = aurora.getBandCacheGeneration();

    expect(cache2).toBeGreaterThan(cache1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/aurora.test.ts`
Expected: FAIL — `getBandCount` / `getBandCacheGeneration` not a function

- [ ] **Step 3: Implement aurora caching**

In `aurora.ts`:

1. Add fields to `AuroraBand` type:
```ts
cachedCanvas: OffscreenCanvas | null;
lastRenderedHue: number;
```

2. Add fields to `AuroraBands` class:
```ts
private cacheGeneration = 0;
private renderWidth = 0;
```

3. Add public accessors:
```ts
getBandCount(): number { return this.bands.length; }
getBandCacheGeneration(): number { return this.cacheGeneration; }
```

4. In `init()`, initialize each band with `cachedCanvas: null, lastRenderedHue: -999`.

5. Add a private method to render a band's OffscreenCanvas:
```ts
private renderBandCache(band: AuroraBand, width: number, height: number): void {
  const bandHeight = Math.ceil(band.heightFraction * height);
  if (!band.cachedCanvas || band.cachedCanvas.width !== width || band.cachedCanvas.height !== bandHeight) {
    band.cachedCanvas = new OffscreenCanvas(width, bandHeight);
  }
  const ctx = band.cachedCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, width, bandHeight);

  const grad = ctx.createLinearGradient(0, 0, 0, bandHeight);
  grad.addColorStop(0, `hsla(${band.hue}, 60%, 50%, 0)`);
  grad.addColorStop(0.5, `hsla(${band.hue}, 60%, 50%, ${band.alpha})`);
  grad.addColorStop(1, `hsla(${band.hue}, 60%, 50%, 0)`);

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, bandHeight);
  band.lastRenderedHue = band.hue;
}
```

6. Replace `render()`:
```ts
render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const w = width;
  const h = height;
  let regenerated = false;

  for (const band of this.bands) {
    // Check if cache needs regeneration
    const hueDelta = Math.abs(band.hue - band.lastRenderedHue);
    if (!band.cachedCanvas || hueDelta >= 5 || this.renderWidth !== w) {
      this.renderBandCache(band, w, h);
      regenerated = true;
    }

    const oscillation = Math.sin(band.phase) * 20;
    const y = band.baseY * h + oscillation;

    ctx.globalAlpha = 1; // alpha is baked into the cached canvas
    ctx.drawImage(band.cachedCanvas!, 0, Math.round(y));
  }

  ctx.globalAlpha = 1;
  this.renderWidth = w;
  if (regenerated) this.cacheGeneration++;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/aurora.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/aurora.ts src/renderer/src/components/visualizer/__tests__/aurora.test.ts
git commit -m "perf(visualizer): cache aurora bands to OffscreenCanvas, regenerate on 5-degree hue shift"
```

---

### Task 5: Bloom Fallback Removal

Remove the dead-code fallback `render()` path that would break in multi-canvas mode.

**Files:**
- Modify: `src/renderer/src/components/visualizer/bloom.ts`

- [ ] **Step 1: Remove fallback render() and OffscreenCanvas buffer**

In `bloom.ts`:

1. Remove the `offCanvas` and `offCtx` private fields.
2. Remove the constructor (no longer needs to create OffscreenCanvas).
3. Remove the `resize()` method.
4. Remove the `render()` method entirely (the fallback full-canvas bloom).
5. Keep `renderShipGlow()` as-is — this is the efficient sprite-based path.

The class becomes:

```ts
import { SPRITE_ATLAS } from './sprite-atlas';
import { isSpriteReady, getSpriteSheet } from './sprite-loader';
import type { Ship } from './ships';

/**
 * BloomPass — per-object glow effect using sprite overlay.
 */
export class BloomPass {
  /** Render per-object glow sprites behind ships. Call BEFORE ship rendering. */
  renderShipGlow(ctx: CanvasRenderingContext2D, ships: Ship[]): void {
    if (!isSpriteReady()) return;

    const sheet = getSpriteSheet();
    const glowRegion = SPRITE_ATLAS['effect-bloom-glow'];
    if (!sheet || !glowRegion) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.35;

    for (const ship of ships) {
      if (ship.despawning || ship.warp.isActive()) continue;

      // Only glow for active states
      if (ship.state === 'idle' || ship.state === 'walking' || ship.state === 'not-agent') continue;

      // Draw glow sprite centered on ship, scaled larger than the ship
      const glowSize = Math.max(ship.width, ship.height) * 2;
      const gx = Math.round(ship.currentX - glowSize / 2);
      const gy = Math.round(ship.currentY - glowSize / 2);

      ctx.drawImage(
        sheet,
        glowRegion.x, glowRegion.y, glowRegion.w, glowRegion.h,
        gx, gy, glowSize, glowSize,
      );
    }

    ctx.restore();
  }
}
```

- [ ] **Step 2: Run all tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All PASS (bloom has no dedicated tests; this verifies no imports break)

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/bloom.ts
git commit -m "perf(visualizer): remove bloom fallback render(), dead code in multi-canvas architecture"
```

---

### Task 6: Particle & Space Weather — In-Place Compaction

Eliminate per-frame array allocations from `.filter()` and `.shift()`.

**Files:**
- Modify: `src/renderer/src/components/visualizer/particles.ts:46-57` (update + spawn)
- Modify: `src/renderer/src/components/visualizer/space-weather.ts:28-36` (update)
- Test: `src/renderer/src/components/visualizer/__tests__/particles.test.ts`

- [ ] **Step 1: Verify existing tests still describe correct behavior**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/particles.test.ts`
Expected: All PASS (baseline)

- [ ] **Step 2: Implement in-place compaction in ParticleSystem**

In `particles.ts`:

1. Replace `update()` filter with in-place compaction:
```ts
update(deltaMs: number): void {
  const dt = deltaMs / 1000;
  let writeIdx = 0;

  for (let i = 0; i < this.particles.length; i++) {
    const p = this.particles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    p.opacity = Math.max(0, (p.life / p.maxLife) * 0.9);
    p.animElapsed += deltaMs;

    if (p.life > 0) {
      this.particles[writeIdx] = p;
      writeIdx++;
    }
  }

  this.particles.length = writeIdx;
}
```

2. Replace `shift()` in `spawn()` with index-0 overwrite:
```ts
// Before:
if (this.particles.length >= MAX_PARTICLES) {
  this.particles.shift();
}

// After:
if (this.particles.length >= MAX_PARTICLES) {
  this.particles[0] = /* the new particle */ ;
  return; // skip the push below
}
```

Refactor the spawn loop to build the particle object first, then either overwrite the oldest or push. Track a `nextOverwriteIdx` to cycle through the array evenly when at capacity (avoids always clobbering index 0 and dropping all but the last particle in a batch):

```ts
private nextOverwriteIdx = 0;

spawn(x: number, y: number, color: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const maxLife = MIN_LIFETIME + Math.random() * (MAX_LIFETIME - MIN_LIFETIME);
    const particle: Particle = {
      x,
      y: y + (Math.random() - 0.5) * 4,
      vx: -(20 + Math.random() * 30),
      vy: (Math.random() - 0.5) * 8,
      opacity: 0.8 + Math.random() * 0.2,
      size: 1 + Math.random() * 2,
      color,
      life: maxLife,
      maxLife,
      animElapsed: 0,
    };

    if (this.particles.length >= MAX_PARTICLES) {
      // Overwrite oldest particles round-robin style
      this.particles[this.nextOverwriteIdx] = particle;
      this.nextOverwriteIdx = (this.nextOverwriteIdx + 1) % MAX_PARTICLES;
    } else {
      this.particles.push(particle);
    }
  }
}
```

- [ ] **Step 3: Implement in-place compaction in SpaceWeather**

In `space-weather.ts`, replace the filter in `update()`:

```ts
// Replace:
this.particles = this.particles.filter((p) => p.life > 0);

// With:
let writeIdx = 0;
for (let i = 0; i < this.particles.length; i++) {
  if (this.particles[i].life > 0) {
    this.particles[writeIdx] = this.particles[i];
    writeIdx++;
  }
}
this.particles.length = writeIdx;
```

Move this compaction to run after the position/life update loop (same location as the current filter).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/components/visualizer/__tests__/particles.test.ts`
Expected: All PASS — behavior unchanged, just internal allocation strategy

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/particles.ts src/renderer/src/components/visualizer/space-weather.ts
git commit -m "perf(visualizer): in-place particle compaction, eliminate per-frame array allocations"
```

---

### Task 7: Space Renderer — Reusable Sort Buffer

Eliminate per-frame spread allocation in ship rendering.

**Files:**
- Modify: `src/renderer/src/components/visualizer/space-renderer.ts:64-75` (render method)

- [ ] **Step 1: Add persistent sortBuffer field**

In `space-renderer.ts`:

1. Add a private field:
```ts
private sortBuffer: Ship[] = [];
```

2. Replace the render method's sort:
```ts
// Before:
const sorted = [...ships].sort((a, b) => a.currentY - b.currentY);
for (const ship of sorted) {

// After:
this.sortBuffer.length = 0;
for (let i = 0; i < ships.length; i++) {
  this.sortBuffer.push(ships[i]);
}
this.sortBuffer.sort((a, b) => a.currentY - b.currentY);
for (const ship of this.sortBuffer) {
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/space-renderer.ts
git commit -m "perf(visualizer): reuse sort buffer in space renderer, eliminate per-frame array spread"
```

---

### Task 8: SpaceCanvas — Multi-Canvas Architecture + Frame Rate Capping + DPR Cap + Visibility Pausing

This is the main architectural change. It restructures `SpaceCanvas.tsx` to use 3 stacked canvases with independent fps-capped loops.

**Files:**
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Add canvas refs and update JSX**

Replace the single `canvasRef` with 3 refs:

```ts
const bgCanvasRef = useRef<HTMLCanvasElement>(null);
const midCanvasRef = useRef<HTMLCanvasElement>(null);
const activeCanvasRef = useRef<HTMLCanvasElement>(null);
```

Update the JSX return:
```tsx
return (
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
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setTooltip(null)}
      className="absolute inset-0 w-full h-full cursor-pointer"
      style={{ imageRendering: 'pixelated' }}
    />
    {tooltip && (
      <div
        className="absolute pointer-events-none bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white shadow-lg z-10"
        style={{ left: tooltip.x, top: tooltip.y }}
      >
        <div className="font-medium">{tooltip.label}</div>
        <div className="text-neutral-400">{tooltip.panes}</div>
      </div>
    )}
  </div>
);
```

- [ ] **Step 2: Create the fps-capped loop helper**

Add a helper function inside or above the component:

```ts
function createThrottledLoop(
  targetFps: number,
  onFrame: (deltaMs: number, timestamp: number) => void,
): { start: () => void; stop: () => void } {
  const interval = 1000 / targetFps;
  let animFrame = 0;
  let lastTime = 0;
  let accumulated = 0;

  function loop(timestamp: number) {
    const rawDelta = lastTime ? timestamp - lastTime : 0;
    lastTime = timestamp;
    // Clamp delta to prevent massive spike after tab-resume or window un-minimize.
    // rAF pauses in hidden tabs, so lastTime can be minutes stale on resume.
    // Cap at 2× interval so physics never jumps more than 2 frames of catch-up.
    const delta = Math.min(rawDelta, interval * 2);
    accumulated += delta;

    if (accumulated >= interval) {
      onFrame(accumulated, timestamp);
      accumulated %= interval;
    }

    animFrame = requestAnimationFrame(loop);
  }

  return {
    start() {
      lastTime = 0;
      accumulated = 0;
      animFrame = requestAnimationFrame(loop);
    },
    stop() {
      cancelAnimationFrame(animFrame);
    },
  };
}
```

- [ ] **Step 3: Create the canvas sizing helper**

```ts
function sizeCanvas(canvas: HTMLCanvasElement): { w: number; h: number } {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  // DPR capped at 1.0 for pixel art
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  return { w: cw, h: ch };
}
```

- [ ] **Step 4: Replace the single game loop with 3 layer loops**

Replace the main `useEffect` (lines 92-206) with 3 separate effects. Each follows this pattern:

**Background loop (10fps):**
```ts
useEffect(() => {
  if (!isVisible) return;
  const canvas = bgCanvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const loop = createThrottledLoop(10, (deltaMs) => {
    const { w, h } = sizeCanvas(canvas);
    const zoom = zoomRef.current;
    const vw = w / zoom;
    const vh = h / zoom;
    ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

    aurora.update(deltaMs);
    nebula.update(deltaMs, vw, vh);

    const camera = cameraRef.current;
    ctx.fillStyle = getDayNightBackground();
    ctx.fillRect(0, 0, vw, vh);
    ctx.translate(-camera.x, -camera.y);

    aurora.render(ctx, vw, vh);
    nebula.render(ctx);
  });

  loop.start();
  return () => loop.stop();
}, [isVisible]);
```

**Mid loop (30fps):**
```ts
useEffect(() => {
  if (!isVisible) return;
  const canvas = midCanvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  if (!starfieldRef.current) {
    starfieldRef.current = new Starfield(canvas.clientWidth, canvas.clientHeight);
  }
  loadSpriteSheet();

  const starfield = starfieldRef.current;
  const shootingStars = shootingStarsRef.current;
  const celestials = celestialsRef.current;
  const asteroidField = asteroidFieldRef.current;

  const loop = createThrottledLoop(30, (deltaMs) => {
    const { w, h } = sizeCanvas(canvas);
    const zoom = zoomRef.current;
    const vw = w / zoom;
    const vh = h / zoom;
    ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

    if (starfield.getWidth() !== Math.ceil(vw) || starfield.getHeight() !== Math.ceil(vh)) {
      starfield.resize(Math.ceil(vw), Math.ceil(vh));
    }

    starfield.update(deltaMs);
    shootingStars.update(deltaMs, vw, vh);
    celestials.update(deltaMs, vw, vh);
    const hasPermissionNeeded = shipManagerRef.current.getShips().some(s => s.state === 'needs-permission');
    asteroidField.update(deltaMs, vw, vh, hasPermissionNeeded);

    const camera = cameraRef.current;
    ctx.clearRect(0, 0, vw, vh);
    ctx.translate(-camera.x, -camera.y);

    starfield.render(ctx);
    shootingStars.render(ctx);
    celestials.render(ctx);
    asteroidField.render(ctx);
  });

  loop.start();
  return () => loop.stop();
}, [isVisible]);
```

**Active loop (30fps):**
```ts
useEffect(() => {
  if (!isVisible) return;
  const canvas = activeCanvasRef.current;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const shipManager = shipManagerRef.current;
  const spaceRenderer = spaceRendererRef.current;
  const spaceWeather = spaceWeatherRef.current;
  const bloom = bloomRef.current ?? new BloomPass();
  if (!bloomRef.current) bloomRef.current = bloom;

  const loop = createThrottledLoop(30, (deltaMs) => {
    const { w, h } = sizeCanvas(canvas);
    const zoom = zoomRef.current;
    const vw = w / zoom;
    const vh = h / zoom;
    ctx.setTransform(zoom, 0, 0, zoom, 0, 0);

    const workingCount = agentsRef.current.filter(a => a.state === 'working').length;
    spaceWeather.update(deltaMs, vw, vh, workingCount);
    shipManager.update(agentsRef.current, deltaMs, vw, vh);
    spaceRenderer.updateTrails(shipManager.getShips(), deltaMs);

    // Camera follow logic
    const camera = cameraRef.current;
    if (camera.following) {
      const ship = shipManager.getShips().find(s => s.paneId === camera.following);
      if (ship) {
        camera.targetX = ship.currentX - vw / 2;
        camera.targetY = ship.currentY - vh / 2;
      } else {
        camera.following = null;
        camera.targetX = 0;
        camera.targetY = 0;
      }
    }
    camera.x += (camera.targetX - camera.x) * 0.05;
    camera.y += (camera.targetY - camera.y) * 0.05;

    ctx.clearRect(0, 0, vw, vh);
    ctx.translate(-camera.x, -camera.y);

    spaceWeather.render(ctx);
    bloom.renderShipGlow(ctx, shipManager.getShips());
    spaceRenderer.render(ctx, shipManager.getShips());
  });

  loop.start();
  return () => loop.stop();
}, [isVisible]);
```

- [ ] **Step 5: Verify visibility pausing is handled**

No additional `visibilitychange` listener is needed. `requestAnimationFrame` already pauses in hidden Chromium/Electron tabs. The `createThrottledLoop` handles the delta spike on resume via `Math.min(rawDelta, interval * 2)` clamping (added in Step 2). This means after a long hidden period, the first frame gets at most 2× the interval as delta, preventing physics jumps. Verify this by reading through the `createThrottledLoop` code and confirming the clamp is present.

- [ ] **Step 6: Update click/hover handlers to use activeCanvasRef**

Replace all references to `canvasRef.current` in `handleClick`, `handleDoubleClick`, `handleMouseMove`, and the wheel effect with `activeCanvasRef.current`.

- [ ] **Step 7: Remove old single-canvas code**

Remove `canvasRef`, remove the old single `useEffect` game loop, remove the old bloom resize call. Remove the `bloomRef.current = new BloomPass(w, h)` constructor call (BloomPass no longer takes constructor args after Task 5).

- [ ] **Step 8: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 9: Manual smoke test**

Run: `npm run dev`
Verify:
- 3 canvases visible in DevTools Elements panel
- Background (aurora + nebula) renders and updates slowly
- Stars scroll with parallax, shooting stars appear
- Ships render and respond to clicks
- Camera follow works on double-click
- Zoom works with scroll wheel
- Tooltip appears on hover

- [ ] **Step 10: Commit**

```bash
git add src/renderer/src/components/visualizer/SpaceCanvas.tsx
git commit -m "perf(visualizer): split into 3 layered canvases (10/30/30 fps), cap DPR at 1.0"
```

---

### Task 9: Final Integration Test

Run the full test suite and verify nothing is broken.

**Files:** None (test-only)

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 2: Manual performance validation**

Run: `npm run dev`

Open Activity Monitor / Task Manager. Compare CPU usage of the Electron renderer process:
- Before: sustained high CPU (expected 20-40% of a core)
- After: should drop to 5-10% of a core when idle

Verify all visual effects still work:
- Stars scroll with parallax (3 layers, far layer blurred)
- Constellation lines appear between nearby mid-layer stars
- Aurora bands oscillate and shift hue
- Nebula clouds drift
- Ships render with correct sprites
- Bloom glow appears behind active ships
- Shooting stars appear periodically
- Celestial bodies (planets, moon, space station) drift
- Space weather particles appear with 3+ working agents
- Asteroids appear during needs-permission state

- [ ] **Step 3: Commit any fixes from integration testing**

If any fixes were needed, commit them individually with descriptive messages.
