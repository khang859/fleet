# Star Command Galaxy Map

**Date:** 2026-03-17
**Status:** Approved

## Overview

Replace the current `StarCommandScene` ring-and-arcs layout with a galaxy map. The station hub sits at center. Sector outposts are scattered around the canvas as animated beacon nodes. Each active crewmate has a shuttle orbiting their sector outpost. Hailing crew send signal pulses toward the hub along visible flight paths. The old `StationRing`, `CrewPodRenderer`, and `CommsBeamRenderer` are deleted and replaced by three new renderer classes.

## Layout

The canvas is a galaxy map. The station hub sprite rotates at `(cx, cy)`. Sector outpost positions are computed on resize: N sectors distributed evenly in angle, each placed at radius `Math.min(w, h) * 0.42` from center. With 4 sectors they sit at N/E/S/W; with 3 at 120° apart; etc. Positions are stored in a `sectorPositions: Map<string, {x, y}>` that is recomputed whenever the canvas resizes or the sector list changes.

Nothing moves except shuttles and signal pulses. The hub rotates in place. Outposts do not move.

## Sector Outposts

**Renderer:** `SectorOutpostRenderer` in `visualizer/sector-outposts.ts`

**Per sector:**
- `beacon` sprite (2-frame, 500ms) drawn at the sector's `(x, y)` position, centered
- Sector `name` in `9px monospace`, centered below the beacon, 14px gap
- Active sector: teal glow circle (`#14b8a6`, radial, ~24px radius, alpha 0.25) drawn under the beacon; beacon at full opacity
- Inactive sector: no glow; beacon and label at 40% opacity

**Interface:**
```ts
class SectorOutpostRenderer {
  render(ctx, sectors: SectorState[], positions: Map<string, {x: number; y: number}>, elapsed: number): void
}
```

No internal state — purely driven by `SectorState[]` and the position map. `elapsed` drives the `beacon` sprite animation via `drawScSprite`.

## Shuttles

**Renderer:** `ShuttleRenderer` in `visualizer/shuttles.ts`

Each crewmate gets one shuttle entry keyed by `crewId`. The shuttle is a small state machine:

| State | Condition | Sprite | Behavior |
|-------|-----------|--------|----------|
| `orbiting` | status `active` or `error` | `shuttle-thrust` | Circles sector outpost at 35px radius |
| `flying-to-hub` | status `hailing` | `shuttle-thrust` | Moves toward hub at 80px/s |
| `returning` | was `flying-to-hub`, reached hub | `shuttle-thrust` | Moves back to outpost |
| `docking` | status changed to `complete` | `dock-sparkle` | One-shot 3-frame anim at outpost, then removed |
| `drifting` | status `lost` | `shuttle-idle` | Drifts slowly outward, fades to 0 alpha over 3s, then removed |

**Orbit details:**
- Each crew entry gets a stable `orbitPhase` (derived from `crewId` hash) and `orbitSpeed` (0.6–1.0 rad/s, varied per crew)
- `error` status: orbit speed jitters by ±50% each frame (`Math.random() * 0.5 + 0.75` multiplier)
- The shuttle sprite is rotated to face its direction of travel (velocity angle)

**Position access:**
```ts
class ShuttleRenderer {
  update(pods: PodState[], positions: Map<string, {x: number; y: number}>, hubX: number, hubY: number, deltaMs: number): void
  render(ctx, elapsed: number): void
  getShuttlePosition(crewId: string): {x: number; y: number} | null
}
```

`getShuttlePosition` returns the shuttle's current world position, or `null` if no shuttle exists for that crew (idle/unknown status). Used by `SignalPulseRenderer` to fire pulses from the correct origin.

**Cleanup:** When a crewmate's status changes from active to idle (or disappears from the crew list), their shuttle entry is removed after any in-progress `docking`/`drifting` animation completes.

## Signal Pulses

**Renderer:** `SignalPulseRenderer` in `visualizer/signal-pulses.ts`

Replaces `CommsBeamRenderer`. Pulses travel as sprites along straight lines between shuttle and hub.

**Spawning:** In the RAF loop, every 3 seconds, for each `hailing` crew: if `ShuttleRenderer.getShuttlePosition(crewId)` returns a position, spawn an outbound pulse from that position toward `(hubX, hubY)`.

**Pulse lifecycle:**
1. **Outbound** — `orb-teal` travels from shuttle → hub over 1200ms
2. **Arrival** — `spark` sprite plays at hub position for one cycle (2 frames × 300ms)
3. **Return** — `orb-amber` travels from hub → shuttle origin over 1200ms
4. **Done** — pulse removed

**Interface:**
```ts
class SignalPulseRenderer {
  addPulse(fromX: number, fromY: number, toX: number, toY: number): void
  update(deltaMs: number): void
  render(ctx, elapsed: number): void
  hasActivePulses(): boolean
}
```

`hasActivePulses()` feeds into the adaptive FPS check (alongside `ShuttleRenderer` active state).

## StarCommandScene Changes

**File:** `src/renderer/src/components/star-command/StarCommandScene.tsx`

The RAF loop and canvas skeleton are unchanged (resize, starfield, visibility pause, adaptive FPS). The frame loop content changes:

### Per-frame order

1. Background fill (`#0a0a1a`)
2. Starfield blit
3. Compute `cx, cy, scale`; recompute `sectorPositions` if sectors ref changed
4. `shuttleRenderer.update(pods, sectorPositions, cx, cy, deltaMs)`
5. `signalPulses.update(deltaMs)`
6. Spawn signal pulses every 3s for hailing crew (using `shuttleRenderer.getShuttlePosition`)
7. `sectorOutposts.render(ctx, sectors, sectorPositions, elapsed)` — back layer
8. `signalPulses.render(ctx, elapsed)` — pulse lines
9. `shuttleRenderer.render(ctx, elapsed)` — shuttles on top of outposts
10. Hub sprite via `drawScSprite` at `(cx, cy)` — always on top
11. `commsBeams.render` — removed

### Adaptive FPS

Activity = any shuttle is `flying-to-hub` or `returning`, or any signal pulse is in flight:
```ts
const isActive = shuttleRenderer.hasActiveShuttles() || signalPulses.hasActivePulses() || hasActiveCrew
```

### Sector positions

```ts
function computeSectorPositions(
  sectors: SectorState[],
  cx: number, cy: number,
  radius: number
): Map<string, {x: number; y: number}>
```

Pure function in `scene-utils.ts`. Distributes N sectors evenly around the given radius. Added alongside existing `mapSectors`/`mapCrew`.

## Files Changed

| File | Action |
|------|--------|
| `src/renderer/src/components/visualizer/sector-outposts.ts` | Create |
| `src/renderer/src/components/visualizer/shuttles.ts` | Create |
| `src/renderer/src/components/visualizer/signal-pulses.ts` | Create |
| `src/renderer/src/components/visualizer/comms-beams.ts` | Delete |
| `src/renderer/src/components/visualizer/station-ring.ts` | Delete |
| `src/renderer/src/components/visualizer/crew-pods.ts` | Delete |
| `src/renderer/src/components/star-command/StarCommandScene.tsx` | Rewrite frame loop |
| `src/renderer/src/components/star-command/scene-utils.ts` | Add `computeSectorPositions` |
| `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts` | Add tests for `computeSectorPositions` |
