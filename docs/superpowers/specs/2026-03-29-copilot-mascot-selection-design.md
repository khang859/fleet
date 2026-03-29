# Copilot Mascot Selection Design

**Date:** 2026-03-29
**Status:** Approved

## Overview

Allow users to choose from different animated mascot sprites in the copilot settings. Ships with 2-3 bundled mascots initially, with the architecture supporting future additions (including potential PixelLab generation).

## Data Model

### MascotDefinition Type

```typescript
type MascotDefinition = {
  id: string;            // matches CopilotSettings.spriteSheet value
  name: string;          // display name, e.g. "Spaceship"
  description: string;   // short flavor text
  thumbnailFrame: number; // frame index to show as preview in settings
};
```

### MASCOT_REGISTRY

A `MASCOT_REGISTRY: MascotDefinition[]` array in `src/shared/constants.ts` alongside `DEFAULT_SETTINGS`. Initial entries:

- `{ id: 'spaceship', name: 'Spaceship', description: 'The classic Fleet vessel', thumbnailFrame: 0 }`
- `{ id: 'robot', name: 'Robot', description: '...', thumbnailFrame: 0 }`
- `{ id: 'cat', name: 'Cat', description: '...', thumbnailFrame: 0 }`

The `DEFAULT_SETTINGS.copilot.spriteSheet` value changes from `'spaceship-default.png'` to `'spaceship'`.

### CopilotSettings Type

No changes needed — the existing `spriteSheet: string` field stores the mascot ID.

## Asset & Sprite Loading

### Sprite Sheet Files

Each mascot has a base64-encoded `.ts` file in `src/renderer/copilot/src/assets/`:

- `sprites-spaceship.ts` — renamed from `copilot-sprites.ts`
- `sprites-robot.ts`
- `sprites-cat.ts`

All sprite sheets follow the existing format: 9 frames at 128px each (1152×128px total), with the same state mapping:
- idle: frames 0, 1
- processing: frames 2, 3, 4
- permission: frames 5, 6
- complete: frames 7, 8

### Sprite Loader

New module `src/renderer/copilot/src/assets/sprite-loader.ts`:

```typescript
import spaceship from './sprites-spaceship';
import robot from './sprites-robot';
import cat from './sprites-cat';

const SPRITE_SHEETS: Record<string, string> = { spaceship, robot, cat };

export function getSpriteSheet(id: string): string {
  return SPRITE_SHEETS[id] ?? SPRITE_SHEETS['spaceship'];
}
```

The fallback ensures backwards compatibility — any unrecognized `spriteSheet` value (including the old `'spaceship-default.png'`) resolves to the default spaceship.

## SpaceshipSprite Component Changes

`SpaceshipSprite.tsx` changes:

1. Read the `spriteSheet` setting from the copilot store (via `settings.spriteSheet`)
2. Call `getSpriteSheet(settings.spriteSheet)` to get the sprite data URL
3. Use the returned data URL in the `backgroundImage` style instead of the hardcoded import

No changes to animation logic, frame indices, or drag/click behavior.

## Settings UI

Replace the placeholder text in `CopilotSettings.tsx` (lines 82-90) with a visual mascot selection grid.

### Layout

A horizontal row of clickable mascot cards. Each card contains:
- A 64px sprite preview showing the mascot's idle frame (using CSS `background-position` and `background-size` to render the thumbnail frame, scaled down from 128px)
- The mascot name below the preview
- A visual selected state (e.g., ring/border highlight on the active mascot)

### Behavior

- Cards iterate over `MASCOT_REGISTRY` from shared constants
- Clicking a card calls `updateSettings({ spriteSheet: mascot.id })`
- The currently selected mascot is determined by matching `settings.spriteSheet` against registry IDs

## Migration

No explicit migration needed. The `getSpriteSheet()` fallback handles the old `'spaceship-default.png'` default value by falling back to `'spaceship'`. Users who haven't changed settings will see the spaceship selected; if they interact with the mascot picker, the value updates to the new ID format.

## Files to Create/Modify

### Create
- `src/renderer/copilot/src/assets/sprites-spaceship.ts` — renamed/copied from `copilot-sprites.ts`
- `src/renderer/copilot/src/assets/sprites-robot.ts` — new mascot sprite sheet
- `src/renderer/copilot/src/assets/sprites-cat.ts` — new mascot sprite sheet
- `src/renderer/copilot/src/assets/sprite-loader.ts` — sprite sheet loader module

### Modify
- `src/shared/constants.ts` — add `MASCOT_REGISTRY`, update default `spriteSheet` value
- `src/shared/types.ts` — add `MascotDefinition` type
- `src/renderer/copilot/src/components/SpaceshipSprite.tsx` — use `getSpriteSheet()` with settings
- `src/renderer/copilot/src/components/CopilotSettings.tsx` — replace placeholder with mascot grid

### Delete
- `src/renderer/copilot/src/assets/copilot-sprites.ts` — replaced by `sprites-spaceship.ts`

## Future Considerations

- **PixelLab generation (Phase 2):** Users could generate custom mascots via the PixelLab MCP server. Would require saving generated sprite sheets to disk and extending the registry dynamically.
- **More mascots:** Adding a new bundled mascot requires only a sprite sheet `.ts` file and a registry entry.
