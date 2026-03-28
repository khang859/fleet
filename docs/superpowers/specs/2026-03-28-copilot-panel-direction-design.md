# Copilot Panel Direction Design

**Date:** 2026-03-28

## Problem

The copilot chat panel always opens downward and to the left of the sprite. When the user drags the sprite to the bottom or left edges of the screen, the panel opens off-screen or in an awkward position.

## Solution

Calculate panel open direction based on sprite position relative to display center, using two independent axes. Direction is computed only when the panel opens (not live during drag).

## Direction Calculation (main process — `copilot-window.ts`)

When `setExpanded(true)` fires:

1. Get sprite bounds and the display it's on via `screen.getDisplayNearestPoint`
2. Compute sprite center: `cx = bounds.x + SPRITE_SIZE/2`, `cy = bounds.y + SPRITE_SIZE/2`
3. Compute display center: `dx = display.bounds.x + display.bounds.width/2`, `dy = display.bounds.y + display.bounds.height/2`
4. **Horizontal:** `cx < dx` → expand right, else expand left
5. **Vertical:** `cy < dy` → expand down, else expand up
6. Window position:
   - Expand right: `x = bounds.x` (sprite at left edge of expanded window)
   - Expand left: `x = bounds.x - (EXPANDED_WIDTH - SPRITE_SIZE)` (current behavior)
   - Expand down: `y = bounds.y` (panel below sprite)
   - Expand up: `y = bounds.y - EXPANDED_HEIGHT` (panel above sprite, sprite at bottom)
7. Send direction to renderer via existing `expanded-changed` IPC event

## Renderer Panel Positioning (`App.tsx`)

- **Vertical down:** `top-[132px]` (current behavior)
- **Vertical up:** `bottom-[132px]`
- Horizontal direction handled entirely by main process window positioning — panel always fills the expanded window width with `right-0 left-0`

## IPC / Preload Changes

- `copilot:expanded-changed` payload changes from `boolean` to `{ expanded: boolean, direction: { horizontal: 'left' | 'right', vertical: 'up' | 'down' } | null }`
- Direction is `null` when collapsing
- Preload `onExpandedChanged` callback signature updated to match
- No new IPC channels needed

## Collapse Behavior

Restores to saved `collapsedPos` as before. Direction state is ephemeral — computed at expansion time, discarded on collapse.

## Edge Cases

- Panel may partially go off-screen if sprite is near center and panel barely fits. This is acceptable.
- Direction only recalculates on open, not during drag.

## Files to Modify

1. `src/main/copilot/copilot-window.ts` — direction calculation + window positioning
2. `src/preload/copilot.ts` — updated IPC payload type
3. `src/renderer/copilot/src/App.tsx` — conditional panel CSS based on direction
