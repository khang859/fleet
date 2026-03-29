# Flexible Mascot Sprite Frames

**Date:** 2026-03-29
**Goal:** Support variable frame counts per mascot for smoother animations while preserving existing 9-frame mascots.

## Background

Current mascots use a fixed 9-frame horizontal WebP sprite sheet (1152x128px) with hardcoded layout: `idle(0,1) processing(2,3,4) permission(5,6) complete(7,8)`. This limits animation smoothness. The new system allows each mascot to define its own frame map via metadata.

## Design

### Approach: Metadata-based frame maps in mascot registry

Each mascot optionally declares an `animations` field mapping each state to frame indices and FPS. When omitted, the system falls back to a `DEFAULT_ANIMATIONS` constant with the legacy 9-frame layout.

### Type changes (`src/shared/types.ts`)

Add new types and extend `MascotDefinition`:

```ts
interface SpriteAnimation {
  frames: number[];
  fps: number;
}

type SpriteAnimations = Record<'idle' | 'processing' | 'permission' | 'complete', SpriteAnimation>;

interface MascotDefinition {
  id: string;
  name: string;
  description: string;
  thumbnailFrame: number;
  animations?: SpriteAnimations;
}
```

### Mascot registry (`src/shared/mascots.ts`)

Export a `DEFAULT_ANIMATIONS` constant for the legacy 9-frame layout:

```ts
export const DEFAULT_ANIMATIONS: SpriteAnimations = {
  idle: { frames: [0, 1], fps: 2 },
  processing: { frames: [2, 3, 4], fps: 4 },
  permission: { frames: [5, 6], fps: 3 },
  complete: { frames: [7, 8], fps: 2 },
};
```

Existing mascots remain unchanged (no `animations` field). New mascots include their frame map:

```ts
{
  id: 'phoenix', name: 'Phoenix', description: 'A blazing space phoenix', thumbnailFrame: 0,
  animations: {
    idle: { frames: [0, 1, 2, 3], fps: 3 },
    processing: { frames: [4, 5, 6, 7, 8, 9], fps: 8 },
    permission: { frames: [10, 11], fps: 3 },
    complete: { frames: [12, 13, 14, 15], fps: 4 },
  }
}
```

### SpaceshipSprite.tsx changes

- Remove hardcoded `SPRITE_ANIMATIONS` constant.
- Look up the current mascot from `MASCOT_REGISTRY` using the settings mascot ID.
- Use `mascot.animations ?? DEFAULT_ANIMATIONS` for animation data.
- Derive total frame count dynamically: `Math.max(...Object.values(animations).flatMap(a => a.frames)) + 1`.
- Use derived frame count for `backgroundSize` instead of hardcoded `SPRITE_SIZE * 9`.
- `useSpriteAnimation` hook receives the resolved animations instead of reading from a module-level constant.

### Assembly script changes (`scripts/assemble-copilot-sprites.ts`)

- Remove `TOTAL_FRAMES = 9` constant.
- Accept any number of input frames (directory mode uses all images found, explicit mode uses all paths provided).
- Output sprite sheet width = `FRAME_SIZE * actualFrameCount`.

### No changes needed

- `src/renderer/copilot/src/assets/sprite-loader.ts` — already mascot-ID based, doesn't care about frame count.

## Recommended frame layout for new 16-frame mascots

Based on game dev best practices for smooth pixel art animation:

| State | Frames | FPS | Reasoning |
|---|---|---|---|
| idle | 4 (0-3) | 3 | Smooth breathing/bob cycle |
| processing | 6 (4-9) | 8 | Most visible state, benefits most from extra frames |
| permission | 2 (10-11) | 3 | Snappy/urgent feel, fewer frames = better |
| complete | 4 (12-15) | 4 | Satisfying celebration payoff |

## Backward compatibility

All 5 existing mascots (officer, robot, cat, bear, kraken) keep working with zero changes. They omit the `animations` field and the system falls back to `DEFAULT_ANIMATIONS` with the legacy 9-frame layout.
