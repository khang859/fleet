# Star Command Galaxy Map

**Date:** 2026-03-17
**Status:** Approved

## Overview

Replace the current `StarCommandScene` ring-and-arcs layout with a galaxy map. The station hub sits at center. Sector outposts are scattered around the canvas as animated beacon nodes. Each active crewmate has a shuttle orbiting their sector outpost. Hailing crew send signal pulses toward the hub along visible flight paths. The old `StationRing`, `CrewPodRenderer`, and `CommsBeamRenderer` are deleted and replaced by three new renderer classes.

## Type Ownership

`SectorState` moves from `visualizer/station-ring.ts` (deleted) to `visualizer/sector-outposts.ts`.
`PodState` moves from `visualizer/crew-pods.ts` (deleted) to `visualizer/shuttles.ts`.
`scene-utils.ts` updates its imports accordingly.

## Layout

The canvas is a galaxy map. The station hub sprite rotates at `(cx, cy)`. Sector outpost positions are computed on resize: N sectors distributed evenly in angle, each placed at radius `Math.min(w, h) * 0.42` from center. With 4 sectors they sit at N/E/S/W; with 3 at 120° apart; etc. Positions are stored in a `sectorPositions: Map<string, {x, y}>` that is recomputed whenever the canvas resizes or the sector list changes.

When `sectors.length === 0`, `computeSectorPositions` returns an empty map and all renderers no-op.

Nothing moves except shuttles and signal pulses. The hub rotates in place. Outposts do not move.

## Sector Outposts

**Renderer:** `SectorOutpostRenderer` in `visualizer/sector-outposts.ts`

**Edge cases:**
- If `sectors.length === 0`: `render` is a no-op.
- If a sector has no entry in `positions`: skip it silently.

**Per sector:**
- `beacon` sprite (2-frame, 500ms) drawn at the sector's `(x, y)` position, centered
- Sector `name` in `9px monospace`, centered below the beacon, 14px gap
- Active sector: teal glow circle (`#14b8a6`, radial, ~24px radius, alpha 0.25) drawn under the beacon; beacon at full opacity
- Inactive sector: no glow; beacon and label at 40% opacity

**Interface:**
```ts
export type SectorState = { id: string; name: string; active: boolean }

class SectorOutpostRenderer {
  render(ctx: CanvasRenderingContext2D, sectors: SectorState[], positions: Map<string, {x: number; y: number}>, elapsed: number): void
}
```

No internal state — purely driven by `SectorState[]` and the position map. `elapsed` drives the `beacon` sprite animation via `drawScSprite`.

## Shuttles

**Renderer:** `ShuttleRenderer` in `visualizer/shuttles.ts`

Each crewmate gets one shuttle entry keyed by `crewId`. The shuttle is a small state machine:

| State | Condition | Sprite | Behavior |
|-------|-----------|--------|----------|
| `orbiting` | status `active` or `error` | `shuttle-thrust` | Circles sector outpost at 35px radius |
| `flying-to-hub` | status `hailing` | `shuttle-thrust` | Moves toward live `(hubX, hubY)` at 80px/s; ShuttleRenderer internally transitions to `returning` when distance to hub ≤ 20px |
| `returning` | was `flying-to-hub`, reached hub | `shuttle-thrust` | Moves toward a snapshot of the outpost position captured at transition time at 80px/s; resumes `orbiting` when distance to snapshot ≤ 20px |
| `docking` | status transitions to `complete` from another active state | `dock-sparkle` | One-shot 3-frame anim at outpost, then entry removed |
| `drifting` | status `lost` | `shuttle-idle` | Drifts in the direction from hub toward shuttle at moment of transition, at 15px/s; alpha fades 1→0 over 3s, then entry removed |

**Status → shuttle entry rules:**
- `idle`: no shuttle entry created; if entry already exists it is removed immediately (no animation).
- `active`/`error`: create entry in `orbiting` state if not already present.
- `hailing`: if already `orbiting`, transition to `flying-to-hub`. If entry doesn't exist, create it in `flying-to-hub` directly.
- `complete`: if entry exists, transition to `docking`. If entry doesn't exist (crew was always complete on first load), skip — no animation spawned.
- `lost`: if entry exists, transition to `drifting`. If entry doesn't exist, skip.
- Crew that disappears from the crew list: entry removed immediately (no animation).
- Crew with `sectorId` not found in `positions`: shuttle entry is not created; `getShuttlePosition` returns `null`.

**Orbit details:**
- `orbitPhase`: initial value `(sum of char codes in crewId) % (2 * Math.PI)` — deterministic. Each frame: `orbitPhase += orbitSpeed * (deltaMs / 1000)` (modulo 2π). This is an incrementing accumulator stored per shuttle entry.
- `orbitSpeed`: `0.6 + 0.4 * ((sum of char codes in crewId) % 100) / 100` rad/s — deterministic range 0.6–1.0
- `error` status: orbit speed jitters by ±50% each frame (`Math.random() * 0.5 + 0.75` multiplier on top of base speed)
- The shuttle sprite is rotated to face its direction of travel (velocity angle) in all states including `orbiting` (tangent to the orbit circle, changing every frame) and `flying-to-hub`/`returning` (fixed toward destination). `shuttle-thrust` frames animate at 100ms regardless of shuttle state.

**Interface:**
```ts
export type PodState = {
  crewId: string
  sectorId: string
  status: 'active' | 'hailing' | 'error' | 'complete' | 'lost' | 'idle'
}

class ShuttleRenderer {
  update(pods: PodState[], positions: Map<string, {x: number; y: number}>, hubX: number, hubY: number, deltaMs: number): void
  render(ctx: CanvasRenderingContext2D, elapsed: number): void
  getShuttlePosition(crewId: string): {x: number; y: number} | null
  hasActiveShuttles(): boolean
}
```

`getShuttlePosition` returns the shuttle's current world position, or `null` if no entry exists.
`hasActiveShuttles()` returns `true` if any shuttle is in `flying-to-hub`, `returning`, `docking`, or `drifting` state — not `orbiting`. Orbiting shuttles (including `active` status) are acceptable at 10fps; the orbit appears smooth at low frame rates. Only non-smooth states (linear travel, one-shot animations, jitter) require 30fps, and the `error` jitter case is covered separately via `hasActiveCrew`. Used for adaptive FPS.

## Signal Pulses

**Renderer:** `SignalPulseRenderer` in `visualizer/signal-pulses.ts`

Replaces `CommsBeamRenderer`. Pulses travel as sprites along straight lines between shuttle and hub.

**Spawning:** In the RAF loop, the `elapsed` timer drives pulse spawning via a single shared `lastPulseSpawn` timestamp (not `Date.now()`), so pulses pause naturally when the RAF loop pauses. Every 3 seconds of accumulated `elapsed`, all currently `hailing` crew fire pulses simultaneously on the same tick. For each hailing crew: if `ShuttleRenderer.getShuttlePosition(crewId)` returns a position, call `addPulse(fromX, fromY, hubX, hubY)`. Then update `lastPulseSpawn = elapsed`.

**Pulse lifecycle:**
1. **Outbound** — `orb-teal` travels from `(fromX, fromY)` → `(toX, toY)` over 1200ms
2. **Arrival** — `spark` sprite plays at hub position for one cycle (2 frames × 300ms)
3. **Return** — `orb-amber` travels from `(toX, toY)` → `(fromX, fromY)` over 1200ms
4. **Done** — pulse entry removed

The return pulse always travels back to the original `fromX, fromY` snapshot captured at spawn time — it does not track the shuttle's current position.

**Interface:**
```ts
class SignalPulseRenderer {
  addPulse(fromX: number, fromY: number, toX: number, toY: number): void
  update(deltaMs: number): void
  render(ctx: CanvasRenderingContext2D, elapsed: number): void
  hasActivePulses(): boolean
}
```

`hasActivePulses()` feeds into the adaptive FPS check.

## StarCommandScene Changes

**File:** `src/renderer/src/components/star-command/StarCommandScene.tsx`

The RAF loop and canvas skeleton are unchanged (resize, starfield, visibility pause, adaptive FPS). The frame loop content changes:

### Per-frame order

1. Background fill (`#0a0a1a`)
2. Starfield blit
3. Compute `cx, cy, scale`; recompute `sectorPositions` if sectors ref changed
4. `shuttleRenderer.update(pods, sectorPositions, cx, cy, deltaMs)` — all coordinates (sector positions, hub position) are in unscaled canvas space; scale is applied only at render time inside each renderer
5. `signalPulses.update(deltaMs)`
6. Spawn signal pulses every 3s (using accumulated `elapsed`) for hailing crew
7. `sectorOutposts.render(ctx, sectors, sectorPositions, elapsed)` — back layer
8. `signalPulses.render(ctx, elapsed)` — pulse orbs
9. `shuttleRenderer.render(ctx, elapsed)` — shuttles on top of outposts
10. Hub sprite: `ctx.imageSmoothingEnabled = false`; `drawScSprite(ctx, 'station-hub', elapsed, cx - hubSize/2, cy - hubSize/2, hubSize, hubSize)` where `hubSize = 128 * scale`

### Adaptive FPS

```ts
const hasActiveCrew = podStatesRef.current.some(
  p => p.status === 'active' || p.status === 'hailing' || p.status === 'error'
)
const isActive = hasActiveCrew || shuttleRenderer.hasActiveShuttles() || signalPulses.hasActivePulses()
const frameBudget = isActive ? 33 : 100 // 30fps vs 10fps
```

`error` status is included in `hasActiveCrew` because error-state shuttles jitter their orbit speed using `Math.random()` every frame and require 30fps to render correctly.

### Sector positions

```ts
function computeSectorPositions(
  sectors: SectorState[],
  cx: number, cy: number,
  radius: number
): Map<string, {x: number; y: number}>
```

Pure function in `scene-utils.ts`. Returns empty map if `sectors.length === 0`. Distributes N sectors evenly around the given radius starting at angle `-Math.PI / 2` (top of canvas). Added alongside existing `mapSectors`/`mapCrew`.

## Files Changed

| File | Action |
|------|--------|
| `src/renderer/src/components/visualizer/sector-outposts.ts` | Create — exports `SectorState`, `SectorOutpostRenderer` |
| `src/renderer/src/components/visualizer/shuttles.ts` | Create — exports `PodState`, `ShuttleRenderer` |
| `src/renderer/src/components/visualizer/signal-pulses.ts` | Create — exports `SignalPulseRenderer` |
| `src/renderer/src/components/visualizer/comms-beams.ts` | Delete |
| `src/renderer/src/components/visualizer/station-ring.ts` | Delete |
| `src/renderer/src/components/visualizer/crew-pods.ts` | Delete |
| `src/renderer/src/components/star-command/StarCommandScene.tsx` | Rewrite frame loop; update imports |
| `src/renderer/src/components/star-command/scene-utils.ts` | Update imports; add `computeSectorPositions` |
| `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts` | Add tests for `computeSectorPositions` |
