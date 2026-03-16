# Pixel Art Visualizer Redesign — Design Spec

**Date:** 2026-03-16
**Scope:** Visualizer only — UI chrome (sidebar, tabs, modals) stays unchanged.

## Overview

Replace procedural canvas drawing in the Fleet visualizer with modern pixel art sprites (Celeste/Hyper Light Drifter style). Clean lines, vibrant colors, dark space backdrop. Ships remain the core metaphor for agents.

## Approach

Sprite sheet atlas: a single 512×512 `sprites.png` with all frames. Loaded once, drawn via `drawImage()` source rectangles. Backgrounds (starfield, nebula, aurora, space weather) stay procedural but get a pixelation post-process pass.

## Sprite Inventory

### Ships

- **Parent ship:** 32×32px, 6 hull variants (up from current 5 — adds one new design)
- **Subagent ship:** 20×20px, 2 hull variants (dedicated subagent designs, separate from parent hulls)
- **Frames per hull:** idle (2), working/thrust (3), warp-in (4), warp-out (4) = 13 frames
- **Color tinting** at draw time for agent state (green=working, blue=reading, gray=idle/walking, amber=needs-permission, teal=waiting) — only one color version per hull needed
- **Total ship frames:** 6×13 + 2×13 = 104
- **Note:** `HULL_COUNT` changes from 5 to 6. Subagent hull selection uses a separate `SUBAGENT_HULL_COUNT = 2` and routes to subagent sprite rows. The `Ship` type gains an `isSubAgent` check for sprite row lookup.

### Asteroids

- 3 variants, 16×16px, 2 rotation frames each = 6 frames

### Celestial Bodies

- 2 planets (32×32px), 1 moon (16×16px), 1 space station (48×48px) = 4 static sprites

### Shooting Star

- 1 streak sprite, 16×4px = 1 frame

### Particles

- Engine trail puff: 4×4px, 3 fade frames
- Warp streak: 8×2px, 2 frames
- Spawn/despawn burst: 8×8px, 4 frames
- Total: 9 particle frames

### Bloom Glow

- Per-ship glow sprite: 16×16px, drawn additively behind each ship and bright object to replace the full-canvas bloom post-process. 1 sprite.

### Total: 125 frames in a 512×512 sprite sheet

## Sprite Sheet Layout

Rows use variable cell sizes. Each sprite is addressed by exact `{x, y, w, h}` in the atlas config, not by row/column math. Rows are left-packed, aligned to top edge.

- **y=0, h=32:** Rows 0–5 — Parent ship hulls (13 frames × 32px = 416px wide per row, 6 rows = 192px tall)
- **y=192, h=20:** Rows 6–7 — Subagent hulls (13 frames × 20px = 260px wide, 2 rows = 40px tall)
- **y=232, h=16:** Row 8 — Asteroids (6 frames × 16px = 96px wide)
- **y=248, h=48:** Row 9 — Celestials (variable widths: 32+32+16+48 = 128px wide, row height = 48px for station)
- **y=296, h=16:** Row 10 — Particles + shooting star + bloom (variable widths, max 16px tall)

**Total used: 312px tall, well within 512×512.**

## Sprite Config

A `sprite-atlas.ts` TypeScript file maps sprite names to `{ x, y, w, h, frames, frameDuration }`. No external JSON metadata. Each frame has explicit coordinates — no row/column assumptions.

## Loading & Drawing

- Single `new Image()` load at visualizer mount, cached in module scope
- **Fallback:** Until the sprite sheet loads (or on load error), the existing procedural renderer is used. The sprite sheet load sets a `spriteReady` flag checked by each render function.
- `imageSmoothingEnabled = false` for crisp pixel scaling
- Ships render at ~3–4× native pixel size based on canvas dimensions

### Rendered Sizes

At 3× scale on a typical 1200×800 canvas:
- Parent ship: 96×96px on screen
- Subagent ship: 60×60px on screen
- Asteroids: 48×48px on screen

The existing layout constants (`Y_START`, `Y_RANGE`, `BASE_X`, drift amplitudes, subagent offsets) need recalibration for the larger rendered sizes. Parent `Ship.width`/`Ship.height` should store the **rendered** (scaled) dimensions, as they're used for hit testing and particle spawn offsets.

### Color Tinting

Tinted frames are **lazily cached** in a `Map<string, CanvasImageSource>` keyed by `${hullVariant}-${frameIndex}-${stateColor}`. On first draw, the sprite is composited on an offscreen canvas (`source-atop` + state color at ~40% opacity) and the result is stored. Subsequent frames hit the cache. Expected max cache size: ~65 entries (5 colors × 13 frames, assuming one hull visible at a time per color — entries for off-screen hulls are evicted on workspace switch).

**Accent colors** (the per-hull stripe/cockpit marking) are baked into the sprite art itself. Since each hull variant is a unique sprite, the accent is part of the design. The state tint overlays on top at low opacity, preserving the accent underneath.

## Pixelation Post-Process (Backgrounds)

Nebula, aurora, starfield, and space weather render procedurally to a 1/4 resolution offscreen canvas, then draw back to main canvas with `imageSmoothingEnabled = false`. This gives a unified pixel grid aesthetic without sprite assets.

## Animation System

- Sprites animate at 8–12 FPS (independent of 60fps render loop)
- Each object tracks `animFrame` and `animTimer`
- State transitions are hard cuts (no blending)

### Ship Animations by State

| State            | Animation       | Behavior                                      |
|------------------|-----------------|-----------------------------------------------|
| idle             | 2-frame breath  | Subtle bob, engine dim                        |
| working          | 3-frame thrust  | Engine flare cycling, trail particles spawn   |
| reading          | 2-frame idle    | Blue tint                                     |
| walking          | 2-frame idle    | Gray tint (same animation as idle)            |
| needs-permission | 2-frame idle    | Amber tint + pulse opacity                    |
| waiting          | 2-frame idle    | Teal tint                                     |
| warp-in          | 4-frame seq     | Plays once, ship materializes                 |
| warp-out         | 4-frame seq     | Plays once, ship dissolves                    |

### Warp Animation Integration

The sprite-based warp-in/warp-out animations **replace** the current `WarpEffect` stretch interpolation. The existing `WarpEffect` time-based system (`currentStretch`, `warpProgress`) is removed. Instead:

- On spawn: ship plays the 4-frame warp-in sprite sequence (materializing from a streak). The `spawnDelay` stagger still applies — each ship starts its warp-in sequence offset by ~100ms.
- On despawn: ship plays the 4-frame warp-out sequence (dissolving into a streak), then is removed.
- The warp frames have the stretch/streak baked into the sprite art itself — no programmatic scaling needed.
- Workspace switch: all ships play warp-out, then warp-in with stagger (same behavior, new visuals).

### Uptime Badges & Overflow Count

These stay **procedural** (text/dot rendering). They render on top of ship sprites at the same relative offsets. No sprite assets needed.

### Other Animations

- Asteroids: 2-frame rotation at ~2 FPS
- Engine puffs: 3 frames then die (each `Particle` gains `animFrame` and `animTimer` fields)
- Warp streaks: 2 frames, burst spawn
- Spawn bursts: 4 frames, single play

## Files Changed

| File | Change |
|------|--------|
| `ships.ts` | Replace procedural drawing with sprite draws + tinting. Add `animFrame`/`animTimer` to ship data. Remove `WarpEffect` stretch logic. Update `HULL_COUNT` to 6, add `SUBAGENT_HULL_COUNT`. Recalibrate layout constants for new rendered sizes. |
| `asteroids.ts` | Replace polygon draws with asteroid sprites |
| `celestials.ts` | Replace gradient circles with planet/moon/station sprites |
| `shooting-stars.ts` | Replace line draws with streak sprite |
| `particles.ts` | Replace circle particles with particle sprites. Add `animFrame`/`animTimer` to `Particle` type. |
| `space-renderer.ts` | Add pixelation post-process, load sprite sheet, manage `spriteReady` flag |
| `bloom.ts` | Replace full-canvas bloom with per-object glow sprite drawn additively behind ships and bright objects |

## Files Unchanged

- `starfield.ts` — Procedural, pixelated by post-process
- `nebula.ts` — Procedural, pixelated by post-process
- `aurora.ts` — Procedural, pixelated by post-process
- `space-weather.ts` — Procedural, pixelated by post-process
- `SpaceCanvas.tsx` — Game loop unchanged
- `ambient-sound.ts` — No visual component
- All UI components (sidebar, tabs, modals, settings)

## New Files

| File | Purpose |
|------|---------|
| `sprite-atlas.ts` | Sprite region definitions (name → x, y, w, h, frames, frameDuration) |
| `sprite-loader.ts` | Image loading, `spriteReady` flag, offscreen tinting canvas, tint cache (`Map<string, CanvasImageSource>`) |
| `src/renderer/src/assets/sprites.png` | The sprite sheet |
