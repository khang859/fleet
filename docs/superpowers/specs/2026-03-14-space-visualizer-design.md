# Space Visualizer Design (Chunk 4 Renderer Redesign)

Replaces the pixel-art office scene from the original Fleet implementation plan with a space-themed visualizer. Agents are spaceships flying left-to-right through a scrolling starfield. Subagents are smaller trailing ships. Visual indicators combine engine thrust intensity with color-coded state.

## Scope

Tasks 4.1–4.4 from the original plan are unchanged (JSONL watcher, agent state tracker, main process wiring, visualizer Zustand store). This spec covers the renderer-side visualization only — replacing Tasks 4.5–4.8 and minimally adjusting Task 4.9.

## Scene & Starfield

Procedural parallax starfield with 3 layers:

| Layer | Speed  | Brightness | Dot size |
| ----- | ------ | ---------- | -------- |
| Far   | Slow   | Dim        | 1px      |
| Mid   | Medium | Brighter   | 1–2px    |
| Near  | Fast   | Brightest  | 2px      |

Stars scroll right-to-left, creating the illusion of ships flying left-to-right. Canvas background is near-black (`#0a0a1a`). No tilemap, no grid. Ships have floating-point X/Y positions in pixel space.

Star density: ~30 near, ~20 mid, ~10 far stars, scaled proportionally to canvas area. Stars are seeded once on mount and persist across hide/show cycles.

Rendering uses `imageRendering: pixelated`, `imageSmoothingEnabled = false`, 60 FPS game loop via `requestAnimationFrame`. The render loop pauses when the panel is hidden (no wasted cycles).

## Ships

16x24 pixel art spaceships drawn procedurally (colored fills, no external sprite sheet assets).

Ship body color is determined by the **state color** (see State Visual Mapping table). The per-agent palette is used only for accent elements (engine glow outline, cockpit tint, wing markings) to distinguish ships in the same state. Each agent gets a unique accent palette using the 6-palette + hue-shift system:

- Agents 0–5: one of 6 base accent palettes
- Agents 6+: palette 0 with progressive hue shifts (`(index - 6) * 60 + 30) % 360`)

Parent agents render at full 16x24 size. Subagents render at ~60% scale (10x15).

### Positioning

Ships use **normalized coordinates** (0–1 range) mapped to canvas dimensions, so they reposition naturally on resize.

- Base X: all ships cruise at `x = 0.35` (left third of canvas)
- Y positions: assigned per-ship, evenly spaced across the canvas height. First ship at `y = 0.15`, spacing = `0.7 / max(shipCount, 1)`. If ships exceed visible height, spacing compresses to fit.
- Ships assigned by spawn order (first agent gets topmost Y slot)

### Subagent Trailing

Subagents trail behind their parent, each offset by `(-0.06, +0.04)` in normalized coords from the previous ship in the convoy. They share the parent's base accent palette with a +60° hue shift. Maximum 4 subagents rendered per parent; additional subagents are represented by a "+N" badge on the last visible subagent.

### Unmapped States

- `walking`: treated as `idle` (no movement concept in space)
- `not-agent`: no ship rendered for that pane

## State Visual Mapping

Each agent state maps to a ship body color and engine trail behavior:

| State              | Ship color      | Engine trail                         |
| ------------------ | --------------- | ------------------------------------ |
| `working`          | Green `#4ade80` | Bright, long exhaust particles (4–6) |
| `reading`          | Blue `#60a5fa`  | Medium exhaust (2–3 particles)       |
| `idle`             | Gray `#9ca3af`  | Dim/no exhaust, ship drifts slightly |
| `needs-permission` | Amber `#fbbf24` | Pulsing glow around ship             |
| `waiting`          | Teal `#34d399`  | Gentle exhaust, steady               |

### Engine Trail Particles

Procedural particles spawned behind the ship. Each particle has position, velocity (drifts left), opacity (fades out), and size. Working state spawns more particles with longer life. Idle spawns 0–1 dim particles.

Global particle cap: ~100 total across all ships. Individual particle lifetime: 0.5–1.5 seconds.

## Spawn & Despawn Effects

### Warp-in (spawn)

Ship appears at the left edge as a horizontal streak (stretched bright pixels), then decelerates (ease-out-cubic) to its cruising position over ~500ms. A brief light burst at the materialization point.

When multiple agents spawn simultaneously (e.g., workspace load), warp-ins are staggered by ~100ms per ship.

### Warp-out (despawn)

Ship accelerates to the right, stretching into a streak, then vanishes over ~500ms. Ship is removed from the scene after the streak exits the canvas.

Subagents warp-out individually when their task completes. If a parent despawns, all its subagents warp-out simultaneously with the parent.

### Workspace Switch

On workspace switch, all ships warp-out simultaneously (no stagger), then new workspace's ships warp-in with the standard staggered animation.

## Interactions

- **Click-to-focus:** clicking a ship focuses the corresponding terminal pane. Hit detection uses bounding box (ship rectangle only, not trail particles). In tab mode, clicking a ship switches to the terminal tab (visualizer disappears) — drawer mode is recommended for ambient monitoring.
- **Hover tooltip:** DOM overlay positioned absolutely over the canvas (not canvas-drawn). Shows agent label, current tool, and uptime. Repositions to stay within canvas bounds near edges.
- **Keyboard shortcut:** `Cmd+Shift+V` toggles the visualizer panel

## Panel Modes

Unchanged from original plan:

- **Drawer:** resizable bottom panel with drag handle
- **Tab:** full-height pane mode

## File Structure

```
src/renderer/components/visualizer/
  starfield.ts          # parallax star layers, scrolling
  ships.ts              # ship state machine, positioning, subagent trailing
  particles.ts          # engine trail particles + warp streak effect
  space-renderer.ts     # canvas rendering: starfield, ships, particles, tooltips
  SpaceCanvas.tsx        # React component: game loop, click/hover handling
```

`VisualizerPanel.tsx` from Task 4.9 references `SpaceCanvas` instead of `OfficeCanvas`. All other panel logic (drawer/tab mode, resize handle, shortcut) is unchanged.

## What's Removed vs. Original Office Plan

- Tilemap and tile types (no grid)
- BFS pathfinding (no navigation needed)
- Desk assignment system
- Sprite sheet loading and bitmap hue-shifting (ships are procedural)
- Matrix rain effect (replaced by warp streak)

## What's Added

- Parallax starfield system (3 layers)
- Particle system for engine trails
- Warp streak effect for spawn/despawn
