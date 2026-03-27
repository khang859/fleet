# Star Command Visual Polish Design

Add pixel art chrome, animations, avatars, and particle effects to the Star Command tab to match the visual design described in `docs/star-command.md`.

## Current State

- **SpaceCanvas** renders a station ring, crew pods, and comms beams via three persistent canvas RAF loops (bg@10fps, mid@30fps, active@30fps)
- **StarCommandTab** has a chat view + config view with a status panel sidebar
- **sprites.png** contains ship sprites assembled from `sprites-raw/` via `scripts/assemble-sprites.ts`
- Visualizer modules: `station-ring.ts`, `crew-pods.ts`, `comms-beams.ts` render status-driven canvas elements
- **SpaceCanvas lives in VisualizerPanel.tsx**, rendered in the main workspace area above all tabs — it is NOT inside StarCommandTab

## Rendering Philosophy Note

The parent spec (`docs/star-command.md`) envisions a CSS-first rendering model with "zero idle cost" — CSS sprite animations for the station, CSS Motion Path for data orbs, and canvas reserved only for one-shot particle effects. The current implementation already uses persistent canvas RAF loops for the station ring, pods, and comms beams.

This design builds on the existing canvas architecture rather than rewriting it. DOM/CSS components (CRT frame, status bar, crew chips, avatars) are CSS-rendered as the parent spec intends. Canvas-rendered elements (shuttle animations, pod overlays, orbs, particles) are rendered within SpaceCanvas's existing RAF loops — not with independent loops. The shuttle animator and particle system expose `update()` and `render()` methods called by SpaceCanvas's active-layer loop, matching how `StationRing`, `CrewPodRenderer`, and `CommsBeamRenderer` already work. The "one-shot" behavior means they simply have no work to do when no animations are active.

## Approach

All new pixel art assets go on a **separate sprite sheet** (`star-command-sprites.png`) with its own assembly script and TypeScript atlas, following the exact same pipeline as the existing ship sprites:

1. `generate-image.ts` → `sprites-staging/star-command/`
2. `remove-background.ts` → `sprites-raw/star-command/`
3. New `assemble-star-command-sprites.ts` → `src/renderer/src/assets/star-command-sprites.png` + `src/renderer/src/components/star-command/sc-sprite-atlas.ts`

## Asset Manifest

All sprites are 16-bit pixel art, retro game aesthetic. Color palette: deep navy (#0a0e1a), teal (#14b8a6), cyan (#06b6d4), amber (#fbbf24), soft red (#ef4444), white (#ffffff).

### Avatars (64x64 each)

| Key                | Description                                          | Frames |
| ------------------ | ---------------------------------------------------- | ------ |
| `admiral-default`  | Commander: long dark coat, high collar, teal headset | 1      |
| `admiral-speaking` | Mouth open, headset glow brighter                    | 1      |
| `admiral-thinking` | Eyes closed, hand on chin, dim headset               | 1      |
| `admiral-alert`    | Eyes wide, headset flashing amber                    | 1      |
| `admiral-standby`  | Relaxed pose, low headset glow                       | 1      |
| `crew-hoodie`      | Hoodie dev, laptop glow on face                      | 1      |
| `crew-headphones`  | Headphones dev, waveform on ear cups                 | 1      |
| `crew-robot`       | Robot crewmate, antenna, visor eyes                  | 1      |
| `crew-cap`         | Cap dev, baseball cap, casual                        | 1      |
| `crew-glasses`     | Glasses dev, round frames, focused                   | 1      |

**10 images, 64x64 each. Sheet row 0-1 (5 per row).**

### CRT Frame Pieces (variable sizes)

| Key             | Size  | Description                                                        |
| --------------- | ----- | ------------------------------------------------------------------ |
| `crt-corner-tl` | 32x32 | Top-left CRT bezel corner, rounded, dark plastic with subtle sheen |
| `crt-corner-tr` | 32x32 | Top-right (mirror of TL)                                           |
| `crt-corner-bl` | 32x32 | Bottom-left                                                        |
| `crt-corner-br` | 32x32 | Bottom-right                                                       |
| `crt-edge-h`    | 32x8  | Horizontal edge tile (repeats)                                     |
| `crt-edge-v`    | 8x32  | Vertical edge tile (repeats)                                       |
| `crt-scanline`  | 4x4   | Scanline overlay pattern tile                                      |

**7 images. Sheet row 2.**

### Status Bar (metal texture)

| Key                 | Size  | Description                                       |
| ------------------- | ----- | ------------------------------------------------- |
| `statusbar-tile`    | 64x24 | Dark brushed metal texture, tileable horizontally |
| `statusbar-rivet`   | 8x8   | Single rivet, dark metal with highlight           |
| `statusbar-divider` | 4x24  | Thin vertical divider groove                      |

**3 images. Sheet row 3.**

### Status Chips

| Key                 | Size  | Description                                       |
| ------------------- | ----- | ------------------------------------------------- |
| `chip-frame`        | 48x20 | Rounded badge frame, dark with subtle border glow |
| `chip-dot-active`   | 8x8   | Teal dot                                          |
| `chip-dot-hailing`  | 8x8   | Amber dot                                         |
| `chip-dot-error`    | 8x8   | Red dot                                           |
| `chip-dot-complete` | 8x8   | Green dot                                         |
| `chip-dot-idle`     | 8x8   | Dim teal dot                                      |
| `chip-dot-lost`     | 8x8   | Grey dot                                          |

**7 images. Sheet row 3 (after statusbar).**

### Shuttle

| Key                | Size  | Description                                     |
| ------------------ | ----- | ----------------------------------------------- |
| `shuttle-idle`     | 24x24 | Small pixel art shuttle, side view, engines off |
| `shuttle-thrust-1` | 24x24 | Engines firing, flame frame 1                   |
| `shuttle-thrust-2` | 24x24 | Engines firing, flame frame 2                   |
| `shuttle-thrust-3` | 24x24 | Engines firing, flame frame 3                   |

**4 images. Sheet row 4.**

### Particle Sprites

| Key                | Size  | Description                    |
| ------------------ | ----- | ------------------------------ |
| `spark-1`          | 8x8   | Small bright spark             |
| `spark-2`          | 8x8   | Slightly different spark shape |
| `gas-puff-1`       | 12x12 | Gas vent cloud frame 1         |
| `gas-puff-2`       | 12x12 | Gas vent cloud frame 2         |
| `gas-puff-3`       | 12x12 | Gas vent cloud frame 3         |
| `explosion-1`      | 16x16 | Small explosion frame 1        |
| `explosion-2`      | 16x16 | Frame 2, expanding             |
| `explosion-3`      | 16x16 | Frame 3, dissipating           |
| `explosion-4`      | 16x16 | Frame 4, fading                |
| `dock-sparkle-1`   | 8x8   | Docking sparkle frame 1        |
| `dock-sparkle-2`   | 8x8   | Frame 2                        |
| `dock-sparkle-3`   | 8x8   | Frame 3                        |
| `thruster-flame-1` | 8x12  | Thruster flame frame 1         |
| `thruster-flame-2` | 8x12  | Frame 2                        |
| `thruster-flame-3` | 8x12  | Frame 3                        |
| `checkmark-holo`   | 16x16 | Green holographic checkmark    |

**16 images. Sheet rows 4-5.**

### Data Orbs

| Key         | Size  | Description                                   |
| ----------- | ----- | --------------------------------------------- |
| `orb-teal`  | 12x12 | Teal data orb with glow (crew → bridge)       |
| `orb-amber` | 12x12 | Amber data orb (bridge → crew)                |
| `orb-cargo` | 16x16 | Larger cargo transfer orb, teal-cyan gradient |

**3 images. Sheet row 5.**

### Beacon

| Key          | Size  | Description               |
| ------------ | ----- | ------------------------- |
| `beacon-on`  | 12x12 | Amber warning beacon, lit |
| `beacon-off` | 12x12 | Beacon, unlit             |

**2 images. Sheet row 5.**

**Total: 52 images. Sheet size: 512x512 (same as existing sheet).**

### Sprite Sheet Layout (pixel-level)

Numbered source files with suffixes (`-1`, `-2`, `-3`) are individual source images that get packed sequentially left-to-right and exposed as a single atlas entry with `frames: N`.

```
Row 0: y=0,   h=64   | Avatars 1-5:   admiral-default(0,0) admiral-speaking(64,0) admiral-thinking(128,0) admiral-alert(192,0) admiral-standby(256,0)
Row 1: y=64,  h=64   | Avatars 6-10:  crew-hoodie(0,64) crew-headphones(64,64) crew-robot(128,64) crew-cap(192,64) crew-glasses(256,64)
Row 2: y=128, h=32   | CRT:           crt-corner-tl(0,128) crt-corner-tr(32,128) crt-corner-bl(64,128) crt-corner-br(96,128) crt-edge-h(128,128,32x8) crt-edge-v(160,128,8x32) crt-scanline(168,128,4x4)
Row 3: y=160, h=24   | StatusBar:     statusbar-tile(0,160,64x24) statusbar-rivet(64,160,8x8) statusbar-divider(72,160,4x24)
                      | Chips:         chip-frame(80,160,48x20) chip-dot-active(128,160,8x8) chip-dot-hailing(136,160) chip-dot-error(144,160) chip-dot-complete(152,160) chip-dot-idle(160,160) chip-dot-lost(168,160)
Row 4: y=184, h=24   | Shuttle:       shuttle-idle(0,184,24x24) shuttle-thrust x3(24,184 / 48,184 / 72,184)
                      | Particles-a:   spark x2(96,184,8x8) gas-puff x3(112,184,12x12)
Row 5: y=208, h=16   | Particles-b:   explosion x4(0,208,16x16) dock-sparkle x3(64,208,8x8) thruster-flame x3(88,208,8x12) checkmark-holo(112,208,16x16)
                      | Orbs:          orb-teal(128,208,12x12) orb-amber(140,208,12x12) orb-cargo(152,208,16x16)
                      | Beacon:        beacon-on(168,208,12x12) beacon-off(180,208,12x12)
```

Max extent: 320x224. Fits easily in 512x512 with room to spare.

## Assembly Script

New file: `scripts/assemble-star-command-sprites.ts`

Follows the exact same pattern as `scripts/assemble-sprites.ts`:

- Reads from `sprites-raw/star-command/` subdirectories
- Outputs `src/renderer/src/assets/star-command-sprites.png`
- Generates `src/renderer/src/components/star-command/sc-sprite-atlas.ts`
- Uses the same `SpriteRegion` interface
- Validates all source files exist before assembly
- Uses sharp for compositing with nearest-neighbor resize

### Staging Directory Layout

```
sprites-staging/star-command/
  avatars/
    admiral-default.png
    admiral-speaking.png
    ...
  chrome/
    crt-corner-tl.png
    crt-edge-h.png
    statusbar-tile.png
    statusbar-rivet.png
    statusbar-divider.png
    chip-frame.png
    chip-dot-active.png
    ...
  shuttle/
    shuttle-idle.png
    shuttle-thrust-1.png
    ...
  particles/
    spark-1.png
    gas-puff-1.png
    explosion-1.png
    dock-sparkle-1.png
    thruster-flame-1.png
    checkmark-holo.png
  orbs/
    orb-teal.png
    orb-amber.png
    orb-cargo.png
  beacon/
    beacon-on.png
    beacon-off.png
```

After `remove-background.ts`, same structure appears in `sprites-raw/star-command/`.

## Phase 1: Asset Pipeline & Sprite Sheet

### What

- Write `scripts/assemble-star-command-sprites.ts`
- Document all fal.ai prompts for the 52 images in a prompt list file
- Generate all images, remove backgrounds, assemble into sheet
- Output: `star-command-sprites.png` + `sc-sprite-atlas.ts`

### Files Created

- `scripts/assemble-star-command-sprites.ts`
- `docs/star-command-visual-prompts.md` (fal.ai prompt list)
- `src/renderer/src/assets/star-command-sprites.png` (generated)
- `src/renderer/src/components/star-command/sc-sprite-atlas.ts` (generated)
- `src/renderer/src/components/star-command/sc-sprite-loader.ts` (image loader)

### Sprite Loader

New file: `src/renderer/src/components/star-command/sc-sprite-loader.ts`

Mirrors the existing `src/renderer/src/components/visualizer/sprite-loader.ts` pattern but loads the Star Command sprite sheet. API:

- `loadScSpriteSheet(): Promise<void>` — loads `star-command-sprites.png` into an `HTMLImageElement`, resolves when loaded
- `isScSpriteReady(): boolean` — returns true after load completes
- `getScSpriteSheet(): HTMLImageElement` — returns the loaded image (throws if not ready)
- `drawScSprite(ctx, key, x, y, scale?)` — draws a static sprite from `SC_SPRITE_ATLAS` at the given position
- `drawScSpriteFrame(ctx, key, frameIndex, x, y, scale?)` — draws a specific animation frame

Defines its own `SpriteRegion` interface inline (same shape as the existing one) to avoid cross-dependency between auto-generated files. Both the DOM components (Avatar, CrtFrame) and the canvas modules (shuttle-anim, sc-particles, crew-pods, comms-beams) use this loader.

For DOM components, the sprite sheet URL is also exposed as `getScSpriteSheetUrl(): string` for use in CSS `background-image`.

### Atlas Output Format

Same `SpriteRegion` interface shape. Keys match the asset manifest above. Example:

```typescript
export const SC_SPRITE_ATLAS: Record<string, SpriteRegion> = {
  'admiral-default': { x: 0, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  'admiral-speaking': { x: 64, y: 0, w: 64, h: 64, frames: 1, frameDuration: 0 },
  // ...
  'crt-corner-tl': { x: 0, y: 128, w: 32, h: 32, frames: 1, frameDuration: 0 },
  // ...
  'shuttle-idle': { x: 0, y: 192, w: 24, h: 24, frames: 1, frameDuration: 0 },
  'shuttle-thrust': { x: 24, y: 192, w: 24, h: 24, frames: 3, frameDuration: 100 }
  // ...
};
```

## Phase 2: CRT Frame & Chrome

### What

Wrap the Star Command terminal area in a CRT bezel frame using sprite tiles. Add a metal status bar between the visualizer and terminal.

### Layout

```
+--[crt-corner-tl]--[crt-edge-h tiles]--[crt-corner-tr]--+
|  [crt-edge-v]                          [crt-edge-v]     |
|  [crt-edge-v]     VISUALIZER           [crt-edge-v]     |
|  [crt-edge-v]                          [crt-edge-v]     |
+--[statusbar-tile]--[rivet]--[statusbar-tile]--[rivet]--+-+
|  [crt-edge-v]                          [crt-edge-v]     |
|  [crt-edge-v]     TERMINAL / CHAT      [crt-edge-v]     |
|  [crt-edge-v]                          [crt-edge-v]     |
+--[crt-corner-bl]--[crt-edge-h tiles]--[crt-corner-br]--+
```

### Integration Architecture

The CRT frame wraps **only the chat/terminal area** inside `StarCommandTab`. The SpaceCanvas (visualizer) lives in `VisualizerPanel.tsx` in a separate part of the DOM tree and is NOT wrapped by the CRT frame. The status bar sits at the top of the CRT frame (not between visualizer and terminal, since they are in different DOM containers).

```
VisualizerPanel (separate component, above tabs)
  └── SpaceCanvas (canvas layers)

StarCommandTab
  └── CrtFrame
        ├── StatusBar (metal bar with rivets + crew chips)
        ├── Chat messages / Config panel
        └── Input bar
        └── Scanline overlay (absolute positioned)
```

### Implementation

New component: `src/renderer/src/components/star-command/CrtFrame.tsx`

- Wraps its `children` in a CRT bezel frame
- Corner pieces are `<div>` elements with sprite background-position from atlas
- Edge tiles repeat via `background-repeat: repeat-x` / `repeat-y`
- Scanline overlay: a full-size `<div>` positioned absolute over the content with the `crt-scanline` tile repeating, `opacity: 0.04`, `pointer-events: none`
- All sprites use `image-rendering: pixelated` for crisp scaling

### Status Bar

New component: `src/renderer/src/components/star-command/StatusBar.tsx`

- Sits at the top of the CRT frame, above the chat area
- Background: `statusbar-tile` repeating horizontally
- Rivets placed at regular intervals using `statusbar-rivet` sprite
- Dividers separate sections
- Contains: Starbase name (left), crew count summary (center), active sector indicator (right)
- Height: 24px (matches tile height)

### Files Created/Modified

- `src/renderer/src/components/star-command/CrtFrame.tsx` (new)
- `src/renderer/src/components/star-command/StatusBar.tsx` (new)
- `src/renderer/src/components/StarCommandTab.tsx` (modified — wrap chat content in CrtFrame, StatusBar above messages)

## Phase 3: Crew Status Chips

### What

A horizontal bar of colored badges across the top of the Star Command tab, grouped by sector. Each chip shows a crew name and a colored dot for their status.

### Layout

```
[statusbar background]
  [Sector: API]  [auth-crew ●] [rate-limit-crew ●]  |  [Sector: Web]  [frontend-crew ●]
```

### Implementation

New component: `src/renderer/src/components/star-command/CrewChips.tsx`

- Renders inside the StatusBar component
- Each chip: `chip-frame` sprite as background, crew ID text, `chip-dot-{status}` sprite for the colored dot
- Grouped by sector with sector label dividers
- Horizontally scrollable if too many chips
- Wired to `useStarCommandStore().crewList` and `sectors`
- Status dot swaps sprite based on crew status (same 6 states as pods)

### Files Created/Modified

- `src/renderer/src/components/star-command/CrewChips.tsx` (new)
- `src/renderer/src/components/star-command/StatusBar.tsx` (modified — embed CrewChips)

## Phase 4: Avatar Portraits

### What

Show Admiral and Crew avatar portraits in the chat message bubbles and status panel sidebar.

### Implementation

New component: `src/renderer/src/components/star-command/Avatar.tsx`

- Props: `type: 'admiral' | 'crew'`, `variant?: string`, `state?: string`, `size?: number`
- Renders a `<div>` with sprite background-position from atlas
- Admiral variants: default, speaking, thinking, alert, standby
- Crew variants: hoodie, headphones, robot, cap, glasses
- Default size: 32x32 (scaled from 64x64 sprite), `image-rendering: pixelated`

### Integration Points

- **MessageBubble**: Admiral messages get `<Avatar type="admiral" state="speaking" />` on the left. User messages unchanged. Crew relayed messages get the crew's avatar variant.
- **StatusPanel**: Each crew entry gets their avatar next to the crew ID.
- **Welcome screen**: Large Admiral avatar (64x64) with "standby" state.

### Admiral State Machine

Admiral avatar state follows the streaming lifecycle:

- `standby` — no active stream
- `thinking` — stream started, waiting for first text chunk
- `speaking` — text chunks arriving
- `alert` — error occurred or crew hailing

### Crew Variant Assignment

When a crew member is deployed, they get a random variant from the 5 options. The variant is stored in the `avatar_variant` column of the `crew` table (already in the schema). The store's `crewList` includes this field.

### Files Created/Modified

- `src/renderer/src/components/star-command/Avatar.tsx` (new)
- `src/renderer/src/components/StarCommandTab.tsx` (modified — add avatars to MessageBubble, StatusPanel, welcome screen)

## Phase 5: Shuttle Dock/Undock Animations

### What

When a crew member is deployed, a shuttle sprite animates from off-screen toward the station and docks at the crew's pod slot. On mission complete, the shuttle undocks and departs.

### Implementation

New module: `src/renderer/src/components/visualizer/shuttle-anim.ts`

- `ShuttleAnimator` class manages active shuttle animations
- Each animation: shuttle sprite at current position, moving along a path from edge to pod position (dock) or pod to edge (undock)
- Uses sprite frames: `shuttle-idle` when stationary near pod, `shuttle-thrust-{1,2,3}` during travel
- Animation duration: 1.5 seconds for approach, 0.5 seconds for docking connection
- Path: straight line from a random edge point to the pod's canvas position

### Trigger

- **Dock**: Fired when `crewList` gains a new entry (status transitions to `active` from not existing)
- **Undock**: Fired when a crew member's status transitions to `complete`
- SpaceCanvas uses a `useRef` holding the previous crew list. On each render, it diffs current vs previous to detect new arrivals and completions. On initial mount, existing crew do NOT trigger dock animations (they are already docked).
- Multiple simultaneous deployments: shuttles animate in parallel (each with a slight random delay offset of 0-200ms to avoid visual overlap).

### Canvas Integration

The `ShuttleAnimator` exposes `update(deltaMs)` and `render(ctx, centerX, centerY)` methods. These are called from SpaceCanvas's existing active-layer 30fps RAF loop, alongside `crewPods.render()` and `commsBeams.render()`. The animator does NOT run its own RAF loop. When no shuttle animations are active, `update()` and `render()` are no-ops (zero cost).

### Files Created/Modified

- `src/renderer/src/components/visualizer/shuttle-anim.ts` (new)
- `src/renderer/src/components/SpaceCanvas.tsx` (modified — integrate ShuttleAnimator, add crew list diffing via useRef)

## Phase 6: Pod Status Animations

### What

Enhanced pod visuals using sprites instead of plain circles. Each pod state has distinct sprite-based animation.

### Current State

`crew-pods.ts` draws colored circles with alpha-based glow. This phase replaces circles with sprite-drawn pods and adds beacon/effect sprites.

### Implementation

Modified: `src/renderer/src/components/visualizer/crew-pods.ts`

- Pod body: still a colored circle (looks good at 6px radius), but with sprite-based overlays for status effects
- **Active**: teal pod with enhanced pulsing glow (no sprite overlay — the existing alpha-based pulse is sufficient)
- **Hailing**: amber pod + `beacon-on`/`beacon-off` alternating at 2fps (CSS-like steps)
- **Error**: red pod + flicker + trigger `spark` particle effect (one-shot, see Phase 7)
- **Complete**: green flash + `checkmark-holo` sprite overlay for 2 seconds, then steady green
- **Lost**: grey pod + trigger `gas-puff` particle effect (one-shot)
- **Idle**: dim teal, no overlay

The beacon sprites are drawn from the atlas onto the canvas at the pod's position. The sprite frame alternates based on elapsed time.

### Files Modified

- `src/renderer/src/components/visualizer/crew-pods.ts` (modified — add sprite overlays)

## Phase 7: Particle Effects

### What

One-shot canvas particle effects triggered by crew status changes. These use the self-terminating RAF pattern from the spec.

### Implementation

New module: `src/renderer/src/components/visualizer/sc-particles.ts`

- `ScParticleSystem` class with a `playEffect(type, x, y)` method
- Effect types:
  - `'thruster'` — 8-12 particles using `thruster-flame` sprites, moving away from shuttle direction, 0.5s lifetime
  - `'dock-sparkle'` — 6-10 particles using `dock-sparkle` sprites, expanding ring, 0.8s lifetime
  - `'hull-spark'` — 4-8 particles using `spark` sprites, random scatter from pod position, 0.6s lifetime
  - `'gas-vent'` — 5-8 particles using `gas-puff` sprites, drifting in one direction, 1.2s lifetime
  - `'explosion'` — Single animated `explosion` sprite (4 frames at 100ms each), 0.4s total
- Each particle: position, velocity, lifetime, current sprite frame
- RAF loop starts on `playEffect()`, self-terminates when all particles dead
- Particles are drawn from the sprite atlas using canvas `drawImage` with sub-rect

### Trigger Map

| Event                         | Effect         | Location       |
| ----------------------------- | -------------- | -------------- |
| Shuttle dock starts           | `thruster`     | Behind shuttle |
| Shuttle docks at pod          | `dock-sparkle` | Pod position   |
| Shuttle undock starts         | `thruster`     | Behind shuttle |
| Crew status → error           | `hull-spark`   | Pod position   |
| Crew status → lost            | `gas-vent`     | Pod position   |
| Crew status → lost (critical) | `explosion`    | Pod position   |

### Canvas Integration

The `ScParticleSystem` exposes `update(deltaMs)` and `render(ctx)` methods called from SpaceCanvas's existing active-layer 30fps RAF loop. It does NOT run its own RAF loop. When no particle effects are active, `update()` and `render()` are no-ops. The "one-shot" behavior means effects self-terminate by removing dead particles — the system simply has no work to do between effects.

### Files Created/Modified

- `src/renderer/src/components/visualizer/sc-particles.ts` (new)
- `src/renderer/src/components/SpaceCanvas.tsx` (modified — integrate particle triggers)

## Phase 8: Data Orb & Comms Visuals

### What

Replace the current plain-circle comms orbs with sprite-based data orbs. Add distinct visuals for different comms types.

### Current State

`comms-beams.ts` renders solid-color circles traveling linearly between positions. This phase upgrades to sprite orbs with glow effects and differentiates crew→bridge vs bridge→crew vs cross-sector cargo.

### Implementation

Modified: `src/renderer/src/components/visualizer/comms-beams.ts`

- Replace circle drawing with sprite `drawImage` from the SC atlas
- **Crew → Bridge (hailing/status)**: `orb-teal` sprite, travels pod → center hub
- **Bridge → Crew (directive)**: `orb-amber` sprite, travels center → pod
- **Cross-Sector Cargo**: `orb-cargo` sprite (larger), travels along supply route arc between sector sections
- Orb glow: draw the sprite at 2x size with low alpha behind the main sprite
- Trail: thin line from start to current position (keep existing behavior)

### API Change

The `addBeam` signature changes from `addBeam(from, to, color)` to `addBeam(from, to, beamType)` where `beamType` is `'hailing' | 'directive' | 'cargo'`. The color is derived internally from the beam type (teal, amber, or cargo gradient). This replaces the `color` parameter entirely.

### Beam Wiring

Currently `CommsBeamRenderer.addBeam()` exists but is never called. This phase also wires it up:

- The `star-command-store` already tracks comms transmissions. Add a `recentComms` field that holds the last N transmission events (with `from_crew`, `to_crew`, `type`).
- SpaceCanvas subscribes to `recentComms` changes. When a new transmission appears, it calls `commsBeams.addBeam(fromId, toId, beamType)` where:
  - `type === 'hailing' || type === 'status_update'` → `beamType = 'hailing'` (teal, pod → hub)
  - `type === 'directive' || type === 'question'` → `beamType = 'directive'` (amber, hub → pod)
  - `type === 'cargo_manifest'` → `beamType = 'cargo'` (larger orb, sector → sector via arc)
- SpaceCanvas diffs `recentComms` via `useRef` (same pattern as crew list diffing) to avoid re-triggering old beams.

### Supply Route Arcs

For cross-sector cargo beams, the orb follows a curved path (quadratic bezier) instead of a straight line. The control point is offset perpendicular to the straight line between sectors, creating an arc that visually follows the station ring.

### Files Modified

- `src/renderer/src/components/visualizer/comms-beams.ts` (modified — sprite orbs, beam types, curved cargo paths)

## Component Structure

All new Star Command visual components live in `src/renderer/src/components/star-command/`:

```
star-command/
  sc-sprite-atlas.ts      (auto-generated)
  sc-sprite-loader.ts     (image preloader)
  CrtFrame.tsx            (CRT bezel wrapper)
  StatusBar.tsx           (metal status bar with rivets)
  CrewChips.tsx           (status chip badges)
  Avatar.tsx              (portrait renderer)
```

Visualizer modules stay in `src/renderer/src/components/visualizer/`:

```
visualizer/
  shuttle-anim.ts         (new — dock/undock)
  sc-particles.ts         (new — one-shot effects)
  crew-pods.ts            (modified — sprite overlays)
  comms-beams.ts          (modified — sprite orbs)
```

## Phase Dependencies

```
Phase 1 (Asset Pipeline)
  ├── Phase 2 (CRT Frame) — needs chrome sprites
  │     └── Phase 3 (Crew Chips) — renders inside StatusBar from Phase 2
  ├── Phase 4 (Avatars) — needs avatar sprites
  ├── Phase 5 (Shuttle) — needs shuttle sprites
  │     └── Phase 7 (Particles) — thruster/dock-sparkle effects triggered by shuttle events
  ├── Phase 6 (Pod Anims) — needs beacon/checkmark sprites, also triggers Phase 7 effects
  └── Phase 8 (Data Orbs) — needs orb sprites
```

All phases depend on Phase 1. Phase 3 depends on Phase 2 (CrewChips renders inside StatusBar). Phase 7 can be built standalone but is most useful after Phase 5 (shuttle triggers) and Phase 6 (pod triggers). Phases 4, 5, 6, and 8 are independent of each other.

## Performance Notes

- All sprite rendering uses `image-rendering: pixelated` (CSS) or nearest-neighbor canvas scaling
- Particle effects use the one-shot RAF pattern — no idle CPU cost
- Sprite sheet is loaded once on component mount and cached
- Avatar state changes are CSS class swaps (background-position change), not re-renders
- CRT frame is static DOM — zero ongoing cost after initial render
- Status chips re-render only when crew list changes (React memo)
- **HiDPI**: Canvas renders at 1x resolution and relies on `image-rendering: pixelated` on the canvas element for crisp scaling. This is intentional for pixel art — rendering at devicePixelRatio would anti-alias the sprites. DOM sprite elements also use `image-rendering: pixelated`.
