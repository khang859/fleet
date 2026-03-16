# Sprite Assembly Script — Design Spec

**Date:** 2026-03-16
**Scope:** Build script that assembles AI-generated sprite PNGs into the final sprite sheet + TypeScript atlas.

## Overview

A Node.js script that reads individual AI-generated sprite images from a `sprites-raw/` folder, resizes them to exact pixel dimensions with nearest-neighbor interpolation, validates completeness, and packs them into the 512x512 sprite sheet. Also generates the `sprite-atlas.ts` config file.

## Input

```
sprites-raw/
  ships/
    parent-{1-6}-{name}-{anim}-{frame}.png
    subagent-{1-2}-{name}-{anim}-{frame}.png
  asteroids/
    {variant}-{frame}.png
  celestials/
    {name}.png
  particles/
    {name}-{frame}.png
  effects/
    shooting-star.png
    bloom-glow.png
```

### Expected Files

**Ships (104 files):**
- `parent-{1-6}-{arrow,dart,wedge,fighter,shuttle,phantom}-{idle-1,idle-2,thrust-1,thrust-2,thrust-3,warp-in-1,warp-in-2,warp-in-3,warp-in-4,warp-out-1,warp-out-2,warp-out-3,warp-out-4}.png`
- `subagent-{1-2}-{drone,scout}-{same 13 animations}.png`

**Asteroids (6 files):**
- `chunky-1.png`, `chunky-2.png`
- `smooth-1.png`, `smooth-2.png`
- `jagged-1.png`, `jagged-2.png`

**Celestials (4 files):**
- `gas-giant.png`, `rocky-world.png`, `moon.png`, `space-station.png`

**Particles (9 files):**
- `engine-puff-1.png`, `engine-puff-2.png`, `engine-puff-3.png`
- `warp-streak-1.png`, `warp-streak-2.png`
- `spawn-burst-1.png`, `spawn-burst-2.png`, `spawn-burst-3.png`, `spawn-burst-4.png`

**Effects (2 files):**
- `shooting-star.png`, `bloom-glow.png`

**Total: 125 files**

## Output

1. `src/renderer/src/assets/sprites.png` — 512x512 assembled sprite sheet
2. `src/renderer/src/components/visualizer/sprite-atlas.ts` — generated TypeScript config

## Processing

1. **Validate** — Check all 125 expected files exist. List any missing files and abort if incomplete.
2. **Resize** — Scale each image to its target pixel size using nearest-neighbor (`sharp.resize({ kernel: 'nearest' })`). No anti-aliasing.
3. **Transparency check** — Warn if any input image has no alpha channel (possible background issue).
4. **Compose** — Create a 512x512 transparent canvas. Composite each resized sprite at its target coordinates per the layout spec.
5. **Write sprite sheet** — Save as PNG.
6. **Generate atlas** — Write `sprite-atlas.ts` with region definitions.

## Sprite Sheet Layout (coordinates)

```
y=0:    Parent hull 1 frames (13 x 32x32)  → x: 0,32,64,...,384
y=32:   Parent hull 2 frames
y=64:   Parent hull 3 frames
y=96:   Parent hull 4 frames
y=128:  Parent hull 5 frames
y=160:  Parent hull 6 frames
y=192:  Subagent hull 1 frames (13 x 20x20) → x: 0,20,40,...,240
y=212:  Subagent hull 2 frames
y=232:  Asteroids (6 x 16x16) → x: 0,16,32,48,64,80
y=248:  Celestials → gas-giant(32x32)@x=0, rocky-world(32x32)@x=32, moon(16x16)@x=64, station(48x48)@x=80
y=296:  Particles + effects (variable) → left-packed by size
```

## Generated Atlas Format

```typescript
export interface SpriteRegion {
  x: number
  y: number
  w: number
  h: number
  frames: number
  frameDuration: number // ms per frame
}

export const SPRITE_ATLAS: Record<string, SpriteRegion> = {
  'parent-1-idle': { x: 0, y: 0, w: 32, h: 32, frames: 2, frameDuration: 500 },
  'parent-1-thrust': { x: 64, y: 0, w: 32, h: 32, frames: 3, frameDuration: 100 },
  'parent-1-warp-in': { x: 160, y: 0, w: 32, h: 32, frames: 4, frameDuration: 125 },
  'parent-1-warp-out': { x: 288, y: 0, w: 32, h: 32, frames: 4, frameDuration: 125 },
  // ... all sprites
}
```

Frame durations:
- idle: 500ms (slow breathing)
- thrust: 100ms (fast engine flicker)
- warp-in/out: 125ms (500ms total / 4 frames)
- asteroids: 500ms (slow rotation)
- particles (engine-puff): 166ms (500ms / 3 frames)
- particles (warp-streak): 150ms (300ms / 2 frames)
- particles (spawn-burst): 100ms (400ms / 4 frames)

## Script Location & Usage

```
scripts/assemble-sprites.ts
```

Run with:
```bash
npx tsx scripts/assemble-sprites.ts
```

## Dependencies

- `sharp` (dev dependency) — image processing, resize, composite
- `tsx` (already available or dev dependency) — run TypeScript directly

## Files Changed

None — this is a new standalone script.

## New Files

| File | Purpose |
|------|---------|
| `scripts/assemble-sprites.ts` | Assembly script |
| `sprites-raw/` | Input folder for AI-generated PNGs (gitignored) |
