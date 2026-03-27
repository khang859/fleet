# Fleet Visualizer Enhancement Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the Fleet Visualizer from a simple starfield + ships scene into a rich, ambient space environment with nebulae, shooting stars, twinkling, celestial bodies, bloom effects, day/night cycles, and interactive camera controls — while keeping it performant and every effect toggleable.

**Architecture:** Each new visual system follows the existing pattern (class with `update(deltaMs)` and `render(ctx)` methods). A central effects config in `FleetSettings.visualizer.effects` gates every feature. The `SpaceCanvas.tsx` game loop orchestrates all systems in a defined render order. Performance budget stays under 5ms/frame total.

**Tech Stack:** Canvas 2D API, Web Audio API (for sound), Zustand stores, React, TypeScript

---

## Context

The Fleet Visualizer currently renders a 3-layer parallax starfield with procedural pixel-art spaceships representing AI agents. The user loves the calming ambient quality of the scrolling starfield and wants to significantly enrich the visual experience. This plan adds 20 enhancements grouped into 7 phases, each delivering visible results independently.

### Current File Structure

```
src/renderer/src/components/visualizer/
  SpaceCanvas.tsx     — Game loop, React wrapper, click/hover
  VisualizerPanel.tsx — Drawer/tab UI wrapper
  starfield.ts        — 3-layer parallax stars
  particles.ts        — ParticleSystem + WarpEffect
  ships.ts            — ShipManager, Ship type, drift/spawn
  space-renderer.ts   — Canvas drawing orchestration
```

### Render Order (Final Target)

1. Background fill (day/night tinted)
2. Aurora bands
3. Nebula clouds
4. Starfield (with color variety + twinkling)
5. Constellation lines
6. Shooting stars
7. Distant planets / celestials / space station
8. Asteroids
9. Engine particles + space weather particles
10. Ships (sorted by Y)
11. Bloom post-processing pass

---

## Phase 1: Settings System + Quick Visual Wins

### Task 1.1: Add effects config to FleetSettings

**Files:**

- Modify: `src/shared/types.ts:82-85`
- Modify: `src/shared/constants.ts` (default settings)

- [ ] **Step 1: Extend FleetSettings type**

Add an `effects` object to the existing `visualizer` settings in `src/shared/types.ts`:

```typescript
export type VisualizerEffects = {
  nebulaClouds: boolean;
  shootingStars: boolean;
  twinklingStars: boolean;
  distantPlanets: boolean;
  auroraBands: boolean;
  constellationLines: boolean;
  coloredTrails: boolean;
  formationFlying: boolean;
  shipBadges: boolean;
  enhancedIdle: boolean;
  dayNightCycle: boolean;
  spaceWeather: boolean;
  asteroidField: boolean;
  spaceStation: boolean;
  ambientSound: boolean;
  followCamera: boolean;
  zoomEnabled: boolean;
  bloomGlow: boolean;
  starColorVariety: boolean;
  depthOfField: boolean;
};

// Update FleetSettings.visualizer:
visualizer: {
  panelMode: 'drawer' | 'tab';
  effects: VisualizerEffects;
  soundVolume: number; // 0-1
}
```

- [ ] **Step 2: Add default effects config in constants**

In `src/shared/constants.ts`, update `DEFAULT_SETTINGS.visualizer` with all effects defaulting to `true` (except `ambientSound: false` since it produces audio).

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts src/shared/constants.ts
git commit -m "feat(visualizer): add effects toggle config to FleetSettings"
```

### Task 1.2: Star color variety

**Files:**

- Modify: `src/renderer/src/components/visualizer/starfield.ts`

- [ ] **Step 1: Add color field to Star type**

```typescript
export type Star = {
  x: number;
  y: number;
  size: number;
  brightness: number;
  color: string; // NEW: hex color tint
};
```

- [ ] **Step 2: Assign random star colors during initLayers**

Weighted distribution: ~70% white `#ffffff`, ~10% pale blue `#aaddff`, ~10% pale yellow `#ffeeaa`, ~5% pale red `#ffbbbb`, ~5% pale orange `#ffddbb`. Apply in the `stars.push()` call inside `initLayers()`.

- [ ] **Step 3: Use star color in render()**

Replace hardcoded `rgba(255, 255, 255, ...)` with the star's color parsed to RGB + brightness alpha. Helper: parse hex to `r,g,b` once at init, store as fields.

- [ ] **Step 4: Verify stars render with color variety, commit**

```bash
git commit -m "feat(visualizer): add star color variety (blue, yellow, red, orange tints)"
```

### Task 1.3: Twinkling stars

**Files:**

- Modify: `src/renderer/src/components/visualizer/starfield.ts`

- [ ] **Step 1: Add twinkle fields to Star type**

```typescript
twinklePhase: number; // current phase
twinkleSpeed: number; // 0 = no twinkle, >0 = speed
```

- [ ] **Step 2: Assign twinkle to ~30% of stars**

In `initLayers()`, set `twinkleSpeed = 0` for 70% of stars, and `twinkleSpeed = 0.5 + Math.random() * 1.5` for the rest. Random initial `twinklePhase`.

- [ ] **Step 3: Advance twinkle phase in update()**

```typescript
if (star.twinkleSpeed > 0) {
  star.twinklePhase += star.twinkleSpeed * dt;
}
```

- [ ] **Step 4: Modulate brightness in render()**

```typescript
const twinkleMod = star.twinkleSpeed > 0 ? 0.15 * Math.sin(star.twinklePhase) : 0;
const alpha = Math.max(0, Math.min(1, star.brightness + twinkleMod));
```

- [ ] **Step 5: Verify twinkling effect, commit**

```bash
git commit -m "feat(visualizer): add star twinkling with subtle brightness oscillation"
```

### Task 1.4: Shooting stars

**Files:**

- Create: `src/renderer/src/components/visualizer/shooting-stars.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create ShootingStarSystem class**

```typescript
type ShootingStar = {
  x: number; y: number;
  vx: number; vy: number;
  length: number;
  brightness: number;
  life: number; maxLife: number;
};

export class ShootingStarSystem {
  private stars: ShootingStar[] = [];
  private spawnTimer = 0;
  private nextSpawn = 3000 + Math.random() * 4000; // 3-7 seconds

  update(deltaMs: number, width: number, height: number): void { ... }
  render(ctx: CanvasRenderingContext2D): void { ... }
}
```

Max 3 active. Each has high velocity (300-500 px/s), slight downward angle, 0.3-0.8s lifetime. Render as a bright head pixel + 3-4 trailing pixels at decreasing opacity.

- [ ] **Step 2: Wire into SpaceCanvas game loop**

Instantiate `ShootingStarSystem` in a ref. Call `update()` and `render()` after starfield, before ships.

- [ ] **Step 3: Verify shooting stars appear, commit**

```bash
git commit -m "feat(visualizer): add occasional shooting star streaks"
```

---

## Phase 2: Background Atmosphere

### Task 2.1: Nebula clouds

**Files:**

- Create: `src/renderer/src/components/visualizer/nebula.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create NebulaSystem class**

Maintains 3-5 large cloud objects. Each cloud pre-renders a radial gradient ellipse onto an `OffscreenCanvas` (one-time, ~200x120px). Colors: muted purple `#3a1a5e`, teal `#1a3a4a`, blue `#1a2a5e`, pink `#4a1a3a`. Very low opacity (0.03-0.06).

- [ ] **Step 2: Implement drift and wrap**

Clouds drift right-to-left at 2-5 px/s. When fully off-screen left, respawn on right with new random Y and color.

- [ ] **Step 3: Render method draws cached canvases**

```typescript
render(ctx: CanvasRenderingContext2D): void {
  for (const cloud of this.clouds) {
    ctx.globalAlpha = cloud.opacity;
    ctx.drawImage(cloud.canvas, Math.round(cloud.x), Math.round(cloud.y));
  }
  ctx.globalAlpha = 1;
}
```

- [ ] **Step 4: Wire into SpaceCanvas, verify, commit**

```bash
git commit -m "feat(visualizer): add drifting nebula cloud backgrounds"
```

### Task 2.2: Aurora bands

**Files:**

- Create: `src/renderer/src/components/visualizer/aurora.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create AuroraBands class**

2-3 horizontal bands, each with a y-position, width (full canvas), base hue, and phase. Render as `createLinearGradient` (vertical) with very low alpha (0.02-0.04). Hue shifts slowly: `hue += 2 * dt` degrees per second.

- [ ] **Step 2: Implement slow vertical drift**

Bands gently oscillate vertically using sine waves (amplitude ~20px, period ~30s).

- [ ] **Step 3: Wire into SpaceCanvas (render before nebula), commit**

```bash
git commit -m "feat(visualizer): add aurora-like color bands in background"
```

### Task 2.3: Distant planets

**Files:**

- Create: `src/renderer/src/components/visualizer/celestials.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create CelestialBodies class**

1-2 slow-moving bodies. Each is a filled arc (circle) with a subtle radial gradient, very dim (opacity 0.08-0.15). Sizes: 20-60px radius. Drift at 1-2 px/s right-to-left.

- [ ] **Step 2: Add optional ring/crater details**

For variety: one body type has a thin ring (elliptical arc), another has 2-3 small darker circles (craters). Keep it simple — 2-3 extra draw calls per body.

- [ ] **Step 3: Wire into SpaceCanvas after shooting stars, commit**

```bash
git commit -m "feat(visualizer): add distant planets/moons in far background"
```

---

## Phase 3: Ship Enhancements

### Task 3.1: Colored engine trails

**Files:**

- Modify: `src/renderer/src/components/visualizer/space-renderer.ts:109-114`

- [ ] **Step 1: Use accent color for trail particles**

Change the `particles.spawn()` call to use `ship.accentColor` instead of `ship.stateColor`. Optionally blend: when working, use accent color; when idle/waiting, interpolate toward a dimmer version.

- [ ] **Step 2: Verify colored trails, commit**

```bash
git commit -m "feat(visualizer): color engine trails with agent accent colors"
```

### Task 3.2: Enhanced idle animations

**Files:**

- Modify: `src/renderer/src/components/visualizer/ships.ts` (Ship type + drift logic)
- Modify: `src/renderer/src/components/visualizer/space-renderer.ts` (render with tilt)

- [ ] **Step 1: Add tiltAngle to Ship type**

```typescript
tiltAngle: number; // radians, small oscillation
```

- [ ] **Step 2: Update drift for idle ships in ShipManager.update()**

When `ship.state === 'idle'`, increase `driftAmountX` by 50% and `driftAmountY` by 50%. Update `tiltAngle` with a slow sine oscillation: `ship.tiltAngle = Math.sin(ship.driftPhaseX * 0.5) * 0.08` (about 5 degrees).

- [ ] **Step 3: Apply rotation in renderShip()**

In `space-renderer.ts`, after `ctx.save()`, translate to ship center and rotate by `ship.tiltAngle` before drawing the hull.

- [ ] **Step 4: Verify idle bob/tilt, commit**

```bash
git commit -m "feat(visualizer): enhanced idle ship drift and tilt animation"
```

### Task 3.3: Ship badges

**Files:**

- Modify: `src/renderer/src/components/visualizer/space-renderer.ts`

- [ ] **Step 1: Add badge rendering after ship hull**

After drawing the hull in `renderShip()`, check `ship.uptime` thresholds:

- 5+ min: 1 small dot (2x2px) above hull in accent color
- 30+ min: 2 dots
- 2+ hours: small chevron (3 fillRect calls forming a V)

- [ ] **Step 2: Verify badges appear, commit**

```bash
git commit -m "feat(visualizer): add uptime badges to ships"
```

---

## Phase 4: Bloom/Glow Post-Processing

### Task 4.1: Bloom pass

**Files:**

- Create: `src/renderer/src/components/visualizer/bloom.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create BloomPass class**

```typescript
export class BloomPass {
  private offCanvas: OffscreenCanvas;
  private offCtx: OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    // Half resolution for performance
    this.offCanvas = new OffscreenCanvas(Math.ceil(width / 2), Math.ceil(height / 2));
    this.offCtx = this.offCanvas.getContext('2d')!;
  }

  resize(width: number, height: number): void { ... }

  render(sourceCtx: CanvasRenderingContext2D, width: number, height: number): void {
    // 1. Scale down source onto offscreen canvas
    // 2. Apply blur filter
    // 3. Composite back with 'screen' blend mode at low opacity
  }
}
```

- [ ] **Step 2: Implement the blur + composite**

```typescript
render(sourceCtx, width, height) {
  const hw = this.offCanvas.width;
  const hh = this.offCanvas.height;

  this.offCtx.clearRect(0, 0, hw, hh);
  this.offCtx.filter = 'blur(4px) brightness(1.5)';
  this.offCtx.drawImage(sourceCtx.canvas, 0, 0, hw, hh);
  this.offCtx.filter = 'none';

  sourceCtx.save();
  sourceCtx.globalCompositeOperation = 'screen';
  sourceCtx.globalAlpha = 0.3;
  sourceCtx.drawImage(this.offCanvas, 0, 0, width, height);
  sourceCtx.restore();
}
```

- [ ] **Step 3: Wire into SpaceCanvas as final render step, commit**

```bash
git commit -m "feat(visualizer): add bloom/glow post-processing pass"
```

---

## Phase 5: Environmental Storytelling

### Task 5.1: Day/night cycle

**Files:**

- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create background color function**

Replace hardcoded `BG_COLOR = '#0a0a1a'` with a function that returns a color based on current hour:

```typescript
function getDayNightBackground(): string {
  const hour = new Date().getHours();
  // Midnight-5am: deep space #0a0a1a
  // 6-8am: dawn tint #120a1a
  // 9am-4pm: slightly lighter #0f0e22
  // 5-7pm: sunset warm #1a100f
  // 8-11pm: evening #0d0a1a
  // Smooth interpolation between keyframes using sine
}
```

- [ ] **Step 2: Apply in game loop, commit**

```bash
git commit -m "feat(visualizer): add time-of-day background color cycle"
```

### Task 5.2: Space weather

**Files:**

- Create: `src/renderer/src/components/visualizer/space-weather.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create SpaceWeather class**

When 3+ agents are in `working` state, spawn extra ambient particles (dust/orange-tinted) moving fast right-to-left. Max 50 particles. Intensity scales with active agent count.

- [ ] **Step 2: Wire into SpaceCanvas, pass agent states, commit**

```bash
git commit -m "feat(visualizer): add space weather particle storms for high activity"
```

### Task 5.3: Asteroid field

**Files:**

- Create: `src/renderer/src/components/visualizer/asteroids.ts`
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create AsteroidField class**

When any ship is in `needs-permission` state, spawn small irregular polygons (3-6 vertex jagged shapes). Max 8 asteroids. Slow drift. Fade in on trigger, fade out when resolved.

- [ ] **Step 2: Render asteroids as path fills, wire into loop, commit**

```bash
git commit -m "feat(visualizer): add asteroid field for error/permission states"
```

### Task 5.4: Space station

**Files:**

- Modify: `src/renderer/src/components/visualizer/celestials.ts`

- [ ] **Step 1: Add SpaceStation to CelestialBodies**

A small pixel-art station (10x10 to 14x14px) drawn as a cross/plus shape with `fillRect` calls. Spawns every 30-60 seconds, traverses screen in ~15s. Mid-layer speed.

- [ ] **Step 2: Verify station appearance, commit**

```bash
git commit -m "feat(visualizer): add space station that periodically drifts by"
```

---

## Phase 6: Interactive Features

### Task 6.1: Camera follow

**Files:**

- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Add camera state**

```typescript
const cameraRef = useRef({ x: 0, y: 0, targetX: 0, targetY: 0, following: null as string | null });
```

- [ ] **Step 2: On double-click, set follow target**

Double-click a ship → set `following` to ship's paneId. Single-click empty space → clear follow.

- [ ] **Step 3: Lerp camera position in game loop**

```typescript
if (camera.following) {
  const ship = shipManager.getShips().find((s) => s.paneId === camera.following);
  if (ship) {
    camera.targetX = ship.currentX - canvasW / 2;
    camera.targetY = ship.currentY - canvasH / 2;
  }
}
camera.x += (camera.targetX - camera.x) * 0.05;
camera.y += (camera.targetY - camera.y) * 0.05;
ctx.translate(-camera.x, -camera.y);
```

- [ ] **Step 4: Adjust hit-test coordinates by camera offset, commit**

```bash
git commit -m "feat(visualizer): add click-to-follow camera for ships"
```

### Task 6.2: Zoom

**Files:**

- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Add zoom state and wheel handler**

```typescript
const zoomRef = useRef(1);
// onWheel: zoomRef.current = clamp(zoomRef.current + e.deltaY * -0.001, 0.5, 2.0)
```

- [ ] **Step 2: Apply zoom in render transform**

```typescript
ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, 0);
```

- [ ] **Step 3: Adjust hit-test coordinates by zoom factor, commit**

```bash
git commit -m "feat(visualizer): add scroll-wheel zoom"
```

### Task 6.3: Formation flying

**Files:**

- Modify: `src/renderer/src/components/visualizer/ships.ts`

- [ ] **Step 1: Replace linear sub-agent positioning with V-formation**

When `formationFlying` is enabled, calculate sub-agent positions as angular offsets from parent:

```typescript
// V-formation: each sub-agent at increasing angle behind parent
const angle = (si % 2 === 0 ? 1 : -1) * (Math.floor(si / 2) + 1) * 0.15;
const distance = (Math.floor(si / 2) + 1) * 0.05;
const subTargetX = BASE_X - distance;
const subTargetY = targetY + angle;
```

- [ ] **Step 2: Verify formation, commit**

```bash
git commit -m "feat(visualizer): add V-formation flying for sub-agents"
```

---

## Phase 7: Sound & Finishing Touches

### Task 7.1: Constellation lines

**Files:**

- Modify: `src/renderer/src/components/visualizer/starfield.ts`

- [ ] **Step 1: Add constellation line rendering**

After rendering stars, check mid-layer star pairs within 40px distance. Draw faint lines (white at 0.05 alpha) between them. Only check mid layer (~20 stars) to keep it O(n^2) cheap.

- [ ] **Step 2: Cache connections, recalculate only when a star wraps, commit**

```bash
git commit -m "feat(visualizer): add faint constellation lines between nearby stars"
```

### Task 7.2: Depth of field

**Files:**

- Modify: `src/renderer/src/components/visualizer/starfield.ts`

- [ ] **Step 1: Render far layer with slight blur**

Use a small offscreen canvas for the far layer. Apply `ctx.filter = 'blur(1px)'` to it, then draw onto main canvas.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(visualizer): add depth-of-field blur for far star layer"
```

### Task 7.3: Ambient soundscape

**Files:**

- Create: `src/renderer/src/components/visualizer/ambient-sound.ts`
- Create: `src/renderer/src/assets/audio/` (audio asset directory)
- Modify: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Create AmbientSoundscape class using Web Audio API**

```typescript
export class AmbientSoundscape {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;

  async init(): Promise<void> { ... }
  setVolume(v: number): void { ... }
  updateActivity(activeCount: number): void { ... }
  dispose(): void { ... }
}
```

Generate a low ambient drone using `OscillatorNode` (very low frequency sine wave) + white noise filtered through a low-pass `BiquadFilterNode`. No audio files needed — pure synthesis.

- [ ] **Step 2: Wire into SpaceCanvas, respect effects toggle + volume setting, commit**

```bash
git commit -m "feat(visualizer): add optional ambient space soundscape"
```

### Task 7.4: Settings UI for effect toggles

**Files:**

- Modify: `src/renderer/src/components/visualizer/VisualizerPanel.tsx`
- Modify: `src/renderer/src/components/SettingsModal.tsx`

- [ ] **Step 1: Add visualizer effects section to SettingsModal**

Group toggles by category (Ambient, Ships, Environment, Interactive, Visual Quality). Use existing shadcn Switch components. Read from/write to `FleetSettings.visualizer.effects` via the settings store.

- [ ] **Step 2: Add sound volume slider when ambient sound is enabled**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(visualizer): add settings UI for all effect toggles"
```

---

## Performance Budget

| System                               | Budget               | Est. Cost  |
| ------------------------------------ | -------------------- | ---------- |
| Starfield (existing + color/twinkle) | 60 stars             | 0.4ms      |
| Shooting stars                       | Max 3                | 0.05ms     |
| Nebula clouds                        | 3-5 cached canvases  | 0.2ms      |
| Aurora bands                         | 2-3 gradients        | 0.3ms      |
| Celestials                           | 1-2 bodies + station | 0.1ms      |
| Engine particles (existing)          | Max 100              | 0.5ms      |
| Space weather                        | Max 50               | 0.3ms      |
| Asteroids                            | Max 8                | 0.1ms      |
| Bloom pass                           | Half-res offscreen   | 1.5ms      |
| Constellation lines                  | ~15 lines            | 0.1ms      |
| **Total**                            |                      | **~3.5ms** |

Frame budget at 60fps = 16.6ms. Existing loop ~3ms + enhancements ~3.5ms = ~6.5ms total. Comfortable headroom.

---

## Verification

After each phase:

1. Run `npm run dev` and open the Fleet Visualizer
2. Verify new effects render correctly alongside existing ones
3. Check console for no errors/warnings
4. Verify 60fps maintained (DevTools Performance tab)
5. Toggle effects on/off in settings to confirm they respond
6. Click ships to verify hit-testing still works
7. Resize drawer to verify responsive behavior

Final integration test: all 20 effects enabled simultaneously, 4+ agent ships active, zoom in/out, click-to-follow a ship, verify smooth performance.
