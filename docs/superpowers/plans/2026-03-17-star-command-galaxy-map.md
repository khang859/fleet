# Star Command Galaxy Map Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ring-and-arcs Star Command scene with a galaxy map — scattered sector outposts, orbiting shuttles, and signal pulses traveling between sectors and the hub.

**Architecture:** Three new visualizer classes replace the three old ones: `SectorOutpostRenderer` (beacon nodes), `ShuttleRenderer` (per-crew state machines), `SignalPulseRenderer` (orb pulses along flight paths). `StarCommandScene` wires them together; `scene-utils.ts` gains `computeSectorPositions`. All coordinates are in unscaled canvas pixels; sprite sizes are fixed.

**Tech Stack:** React, TypeScript, Canvas 2D API, existing `sc-sprite-loader` / `sc-sprite-atlas`, Vitest.

---

## File Map

| File                                                                     | Action | Responsibility                                                                        |
| ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------- |
| `src/renderer/src/components/visualizer/sector-outposts.ts`              | Create | `SectorState` type + `SectorOutpostRenderer` — draws beacon + label + glow per sector |
| `src/renderer/src/components/visualizer/shuttles.ts`                     | Create | `PodState` type + `ShuttleRenderer` — per-crew shuttle state machine                  |
| `src/renderer/src/components/visualizer/signal-pulses.ts`                | Create | `SignalPulseRenderer` — orb pulses traveling sector ↔ hub                             |
| `src/renderer/src/components/star-command/scene-utils.ts`                | Modify | Update type imports; add `computeSectorPositions`                                     |
| `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts` | Modify | Add tests for `computeSectorPositions`                                                |
| `src/renderer/src/components/star-command/StarCommandScene.tsx`          | Modify | Replace frame loop with galaxy map rendering                                          |
| `src/renderer/src/components/visualizer/station-ring.ts`                 | Delete | Replaced by `sector-outposts.ts`                                                      |
| `src/renderer/src/components/visualizer/crew-pods.ts`                    | Delete | Replaced by `shuttles.ts`                                                             |
| `src/renderer/src/components/visualizer/comms-beams.ts`                  | Delete | Replaced by `signal-pulses.ts`                                                        |

---

### Task 1: Create `sector-outposts.ts`

**Files:**

- Create: `src/renderer/src/components/visualizer/sector-outposts.ts`

No tests — canvas renderer. Typecheck is the verification step.

- [ ] **Step 1: Create the file**

```ts
import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader';

export type SectorState = {
  id: string;
  name: string;
  active: boolean;
};

export class SectorOutpostRenderer {
  render(
    ctx: CanvasRenderingContext2D,
    sectors: SectorState[],
    positions: Map<string, { x: number; y: number }>,
    elapsed: number
  ): void {
    if (sectors.length === 0) return;
    if (!isScSpriteReady()) return;

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const sector of sectors) {
      const pos = positions.get(sector.id);
      if (!pos) continue;
      const { x, y } = pos;

      // Active glow
      if (sector.active) {
        const grad = ctx.createRadialGradient(x, y, 0, x, y, 24);
        grad.addColorStop(0, 'rgba(20,184,166,0.25)');
        grad.addColorStop(1, 'rgba(20,184,166,0)');
        ctx.beginPath();
        ctx.arc(x, y, 24, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.globalAlpha = 1;
        ctx.fill();
      }

      // Beacon sprite (12×12 centered)
      ctx.globalAlpha = sector.active ? 1 : 0.4;
      drawScSprite(ctx, 'beacon', elapsed, x - 6, y - 6, 12, 12);

      // Label — 14px below bottom of beacon
      ctx.globalAlpha = sector.active ? 0.9 : 0.4;
      ctx.fillStyle = '#ffffff';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(sector.name, x, y + 20); // 6 (half beacon) + 14 (gap)
    }

    ctx.restore();
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck:web 2>&1 | grep "sector-outposts" | head -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/sector-outposts.ts
git commit -m "feat(star-command): add SectorOutpostRenderer and SectorState type"
```

---

### Task 2: Create `shuttles.ts`

**Files:**

- Create: `src/renderer/src/components/visualizer/shuttles.ts`

The most complex class. Read the spec carefully before implementing. Key constants: `ORBIT_RADIUS = 35`, `TRAVEL_SPEED = 80` px/s, `ARRIVAL_THRESHOLD = 20` px, `DOCK_DURATION = 450` ms (3 frames × 150ms), `DRIFT_DURATION = 3000` ms.

- [ ] **Step 1: Create the file**

```ts
import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader';

export type PodState = {
  crewId: string;
  sectorId: string;
  status: 'active' | 'hailing' | 'error' | 'complete' | 'lost' | 'idle';
};

type ShuttleState = 'orbiting' | 'flying-to-hub' | 'returning' | 'docking' | 'drifting';

type ShuttleEntry = {
  crewId: string;
  sectorId: string;
  state: ShuttleState;
  x: number;
  y: number;
  vx: number; // velocity used for sprite rotation
  vy: number;
  orbitPhase: number; // accumulates each frame
  orbitSpeed: number; // rad/s (0.6–1.0), deterministic from crewId
  alpha: number; // 1.0 normally; fades in drifting
  returnTargetX: number; // snapshot of outpost at time of returning-state entry
  returnTargetY: number;
  dockElapsed: number; // ms elapsed in docking animation
  driftElapsed: number; // ms elapsed while drifting
};

const ORBIT_RADIUS = 35;
const TRAVEL_SPEED = 80; // px/s
const ARRIVAL_THRESHOLD = 20; // px
const DOCK_DURATION = 450; // ms (3 frames × 150ms)
const DRIFT_DURATION = 3000; // ms

function crewHash(id: string): number {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return sum;
}

export class ShuttleRenderer {
  private entries = new Map<string, ShuttleEntry>();
  private lastStatus = new Map<string, PodState['status']>();

  update(
    pods: PodState[],
    positions: Map<string, { x: number; y: number }>,
    hubX: number,
    hubY: number,
    deltaMs: number
  ): void {
    const dt = deltaMs / 1000;
    const activeCrew = new Set(pods.map((p) => p.crewId));

    // Remove entries for crew no longer in the list
    for (const [id] of this.entries) {
      if (!activeCrew.has(id)) {
        this.entries.delete(id);
        this.lastStatus.delete(id);
      }
    }

    for (const pod of pods) {
      const prevStatus = this.lastStatus.get(pod.crewId);
      const statusChanged = prevStatus !== undefined && prevStatus !== pod.status;
      const sectorPos = positions.get(pod.sectorId);
      let entry = this.entries.get(pod.crewId);

      // Idle: no shuttle
      if (pod.status === 'idle') {
        this.entries.delete(pod.crewId);
        this.lastStatus.set(pod.crewId, pod.status);
        continue;
      }

      // No sector position: skip
      if (!sectorPos) {
        this.lastStatus.set(pod.crewId, pod.status);
        continue;
      }

      const { x: sx, y: sy } = sectorPos;

      // Create entry if none exists
      if (!entry) {
        // First observation as complete/lost: skip animation
        if (pod.status === 'complete' || pod.status === 'lost') {
          this.lastStatus.set(pod.crewId, pod.status);
          continue;
        }
        const hash = crewHash(pod.crewId);
        const initPhase = hash % (2 * Math.PI); // 0..2π, deterministic
        const speed = 0.6 + (0.4 * (hash % 100)) / 100;
        entry = {
          crewId: pod.crewId,
          sectorId: pod.sectorId,
          state: pod.status === 'hailing' ? 'flying-to-hub' : 'orbiting',
          x: sx + Math.cos(initPhase) * ORBIT_RADIUS,
          y: sy + Math.sin(initPhase) * ORBIT_RADIUS,
          vx: 0,
          vy: 0,
          orbitPhase: initPhase,
          orbitSpeed: speed,
          alpha: 1,
          returnTargetX: sx,
          returnTargetY: sy,
          dockElapsed: 0,
          driftElapsed: 0
        };
        this.entries.set(pod.crewId, entry);
      }

      // Re-trigger flying-to-hub whenever hailing and back to orbiting
      if (pod.status === 'hailing' && entry.state === 'orbiting') {
        entry.state = 'flying-to-hub';
      }

      // Handle explicit status transitions
      if (statusChanged) {
        if (pod.status === 'complete' && entry.state !== 'docking') {
          entry.state = 'docking';
          entry.dockElapsed = 0;
          entry.x = sx;
          entry.y = sy;
        } else if (pod.status === 'lost' && entry.state !== 'drifting') {
          entry.state = 'drifting';
          entry.driftElapsed = 0;
          entry.alpha = 1;
          const dx = entry.x - hubX;
          const dy = entry.y - hubY;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          entry.vx = (dx / dist) * 15;
          entry.vy = (dy / dist) * 15;
        }
      }

      this.lastStatus.set(pod.crewId, pod.status);

      // Physics update
      switch (entry.state) {
        case 'orbiting': {
          let speed = entry.orbitSpeed;
          if (pod.status === 'error') speed *= Math.random() * 0.5 + 0.75;
          entry.orbitPhase += speed * dt;
          if (entry.orbitPhase > Math.PI * 2) entry.orbitPhase -= Math.PI * 2;
          const newX = sx + Math.cos(entry.orbitPhase) * ORBIT_RADIUS;
          const newY = sy + Math.sin(entry.orbitPhase) * ORBIT_RADIUS;
          entry.vx = (newX - entry.x) / Math.max(dt, 0.001);
          entry.vy = (newY - entry.y) / Math.max(dt, 0.001);
          entry.x = newX;
          entry.y = newY;
          break;
        }
        case 'flying-to-hub': {
          const dx = hubX - entry.x;
          const dy = hubY - entry.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= ARRIVAL_THRESHOLD) {
            // Snapshot outpost for return trip
            const sp = positions.get(entry.sectorId);
            entry.returnTargetX = sp ? sp.x : sx;
            entry.returnTargetY = sp ? sp.y : sy;
            entry.state = 'returning';
          } else {
            const step = Math.min(TRAVEL_SPEED * dt, dist);
            entry.vx = (dx / dist) * TRAVEL_SPEED;
            entry.vy = (dy / dist) * TRAVEL_SPEED;
            entry.x += (dx / dist) * step;
            entry.y += (dy / dist) * step;
          }
          break;
        }
        case 'returning': {
          const dx = entry.returnTargetX - entry.x;
          const dy = entry.returnTargetY - entry.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist <= ARRIVAL_THRESHOLD) {
            entry.state = 'orbiting';
          } else {
            const step = Math.min(TRAVEL_SPEED * dt, dist);
            entry.vx = (dx / dist) * TRAVEL_SPEED;
            entry.vy = (dy / dist) * TRAVEL_SPEED;
            entry.x += (dx / dist) * step;
            entry.y += (dy / dist) * step;
          }
          break;
        }
        case 'docking': {
          entry.dockElapsed += deltaMs;
          if (entry.dockElapsed >= DOCK_DURATION) {
            this.entries.delete(pod.crewId);
          }
          break;
        }
        case 'drifting': {
          entry.driftElapsed += deltaMs;
          entry.x += entry.vx * dt;
          entry.y += entry.vy * dt;
          entry.alpha = Math.max(0, 1 - entry.driftElapsed / DRIFT_DURATION);
          if (entry.driftElapsed >= DRIFT_DURATION) {
            this.entries.delete(pod.crewId);
          }
          break;
        }
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, elapsed: number): void {
    if (!isScSpriteReady()) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const entry of this.entries.values()) {
      if (entry.state === 'docking') {
        // dock-sparkle (8×8 centered at outpost)
        ctx.globalAlpha = 1;
        drawScSprite(ctx, 'dock-sparkle', entry.dockElapsed, entry.x - 4, entry.y - 4, 8, 8);
        continue;
      }

      ctx.globalAlpha = entry.state === 'drifting' ? entry.alpha : 1;

      // Rotate sprite to face direction of travel
      const angle = Math.atan2(entry.vy, entry.vx);
      const spriteKey = entry.state === 'drifting' ? 'shuttle-idle' : 'shuttle-thrust';

      ctx.save();
      ctx.translate(entry.x, entry.y);
      ctx.rotate(angle);
      drawScSprite(ctx, spriteKey, elapsed, -12, -12, 24, 24);
      ctx.restore();
    }

    ctx.restore();
  }

  getShuttlePosition(crewId: string): { x: number; y: number } | null {
    const entry = this.entries.get(crewId);
    return entry ? { x: entry.x, y: entry.y } : null;
  }

  hasActiveShuttles(): boolean {
    for (const entry of this.entries.values()) {
      if (
        entry.state === 'flying-to-hub' ||
        entry.state === 'returning' ||
        entry.state === 'docking' ||
        entry.state === 'drifting'
      )
        return true;
    }
    return false;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck:web 2>&1 | grep "shuttles" | head -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/shuttles.ts
git commit -m "feat(star-command): add ShuttleRenderer with orbit/fly/dock/drift state machine"
```

---

### Task 3: Create `signal-pulses.ts`

**Files:**

- Create: `src/renderer/src/components/visualizer/signal-pulses.ts`

Pulses travel outbound as `orb-teal` (1200ms), arrive with `spark` (600ms), return as `orb-amber` (1200ms).

- [ ] **Step 1: Create the file**

```ts
import { drawScSprite, isScSpriteReady } from '../star-command/sc-sprite-loader';

type PulsePhase = 'outbound' | 'arriving' | 'return';

type PulseEntry = {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  phase: PulsePhase;
  elapsed: number; // ms elapsed within current phase
};

const TRAVEL_MS = 1200;
const ARRIVE_MS = 600; // spark: 2 frames × 300ms

export class SignalPulseRenderer {
  private pulses: PulseEntry[] = [];

  addPulse(fromX: number, fromY: number, toX: number, toY: number): void {
    this.pulses.push({ fromX, fromY, toX, toY, phase: 'outbound', elapsed: 0 });
  }

  update(deltaMs: number): void {
    const surviving: PulseEntry[] = [];
    for (const pulse of this.pulses) {
      pulse.elapsed += deltaMs;
      if (pulse.phase === 'outbound' && pulse.elapsed >= TRAVEL_MS) {
        pulse.phase = 'arriving';
        pulse.elapsed = 0;
      } else if (pulse.phase === 'arriving' && pulse.elapsed >= ARRIVE_MS) {
        pulse.phase = 'return';
        pulse.elapsed = 0;
      } else if (pulse.phase === 'return' && pulse.elapsed >= TRAVEL_MS) {
        continue; // done — drop it
      }
      surviving.push(pulse);
    }
    this.pulses = surviving;
  }

  render(ctx: CanvasRenderingContext2D, elapsed: number): void {
    if (!isScSpriteReady()) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;

    for (const pulse of this.pulses) {
      let x: number, y: number, spriteKey: string, half: number;

      if (pulse.phase === 'outbound') {
        const t = Math.min(pulse.elapsed / TRAVEL_MS, 1);
        x = pulse.fromX + (pulse.toX - pulse.fromX) * t;
        y = pulse.fromY + (pulse.toY - pulse.fromY) * t;
        spriteKey = 'orb-teal';
        half = 6;
      } else if (pulse.phase === 'arriving') {
        x = pulse.toX;
        y = pulse.toY;
        spriteKey = 'spark';
        half = 4;
      } else {
        const t = Math.min(pulse.elapsed / TRAVEL_MS, 1);
        x = pulse.toX + (pulse.fromX - pulse.toX) * t;
        y = pulse.toY + (pulse.fromY - pulse.toY) * t;
        spriteKey = 'orb-amber';
        half = 6;
      }

      drawScSprite(ctx, spriteKey, elapsed, x - half, y - half, half * 2, half * 2);
    }

    ctx.restore();
  }

  hasActivePulses(): boolean {
    return this.pulses.length > 0;
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck:web 2>&1 | grep "signal-pulses" | head -5
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/signal-pulses.ts
git commit -m "feat(star-command): add SignalPulseRenderer (orb-teal/spark/orb-amber)"
```

---

### Task 4: Update `scene-utils.ts` — add `computeSectorPositions`, update type imports

**Files:**

- Modify: `src/renderer/src/components/star-command/scene-utils.ts`
- Modify: `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts`

- [ ] **Step 1: Write the failing tests for `computeSectorPositions`**

Add to `src/renderer/src/components/star-command/__tests__/scene-utils.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mapSectors, mapCrew, computeSectorPositions } from '../scene-utils';
import type { SectorInfo, CrewStatus } from '../../../store/star-command-store';

// ... existing makeSector / makeCrew helpers and tests stay unchanged ...

describe('computeSectorPositions', () => {
  it('returns empty map for empty sectors', () => {
    const result = computeSectorPositions([], 300, 200, 100);
    expect(result.size).toBe(0);
  });

  it('places a single sector at top (angle -π/2)', () => {
    const sectors = [{ id: 'api', name: 'api', active: false }];
    const result = computeSectorPositions(sectors, 300, 200, 100);
    const pos = result.get('api')!;
    expect(pos.x).toBeCloseTo(300); // cos(-π/2) = 0, so x = cx
    expect(pos.y).toBeCloseTo(100); // sin(-π/2) = -1, so y = cy - radius
  });

  it('places two sectors 180° apart', () => {
    const sectors = [
      { id: 'a', name: 'a', active: false },
      { id: 'b', name: 'b', active: false }
    ];
    const result = computeSectorPositions(sectors, 300, 200, 100);
    const a = result.get('a')!;
    const b = result.get('b')!;
    // They should be exactly opposite: a.x + b.x ≈ 2*cx, a.y + b.y ≈ 2*cy
    expect(a.x + b.x).toBeCloseTo(600);
    expect(a.y + b.y).toBeCloseTo(400);
  });

  it('all sectors are at the specified radius from center', () => {
    const sectors = [
      { id: 'a', name: 'a', active: false },
      { id: 'b', name: 'b', active: false },
      { id: 'c', name: 'c', active: false }
    ];
    const cx = 400,
      cy = 300,
      radius = 150;
    const result = computeSectorPositions(sectors, cx, cy, radius);
    for (const [, pos] of result) {
      const dist = Math.sqrt((pos.x - cx) ** 2 + (pos.y - cy) ** 2);
      expect(dist).toBeCloseTo(radius);
    }
  });
});
```

- [ ] **Step 2: Run tests — verify `computeSectorPositions` tests fail**

```bash
npx vitest run src/renderer/src/components/star-command/__tests__/scene-utils.test.ts 2>&1 | tail -10
```

Expected: 4 new tests FAIL (function not found), existing 6 tests still PASS.

- [ ] **Step 3: Update `scene-utils.ts`**

Replace the entire file:

```ts
import type { SectorInfo, CrewStatus } from '../../store/star-command-store';
import type { SectorState } from '../visualizer/sector-outposts';
import type { PodState } from '../visualizer/shuttles';

const VALID_POD_STATUSES = new Set<string>([
  'active',
  'hailing',
  'error',
  'complete',
  'lost',
  'idle'
]);

export function mapSectors(sectors: SectorInfo[], crew: CrewStatus[]): SectorState[] {
  return sectors.map((s) => ({
    id: s.id,
    name: s.name,
    active: crew.some((c) => c.sector_id === s.id && c.status === 'active')
  }));
}

export function mapCrew(crew: CrewStatus[]): PodState[] {
  return crew.map((c) => ({
    crewId: c.id,
    sectorId: c.sector_id,
    status: (VALID_POD_STATUSES.has(c.status) ? c.status : 'idle') as PodState['status']
  }));
}

export function computeSectorPositions(
  sectors: SectorState[],
  cx: number,
  cy: number,
  radius: number
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (sectors.length === 0) return positions;
  const count = sectors.length;
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
    positions.set(sectors[i].id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius
    });
  }
  return positions;
}
```

- [ ] **Step 4: Run all tests — verify all 10 pass**

```bash
npx vitest run src/renderer/src/components/star-command/__tests__/scene-utils.test.ts 2>&1 | tail -10
```

Expected: 10/10 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/star-command/scene-utils.ts src/renderer/src/components/star-command/__tests__/scene-utils.test.ts
git commit -m "feat(star-command): add computeSectorPositions; update scene-utils type imports"
```

---

### Task 5: Rewrite `StarCommandScene.tsx` — galaxy map frame loop

**Files:**

- Modify: `src/renderer/src/components/star-command/StarCommandScene.tsx`

Replace the frame loop to use the three new renderers. The canvas skeleton, starfield, lifecycle, and store subscription are unchanged.

- [ ] **Step 1: Replace the file**

```tsx
import { useRef, useEffect } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import { SectorOutpostRenderer } from '../visualizer/sector-outposts';
import { ShuttleRenderer } from '../visualizer/shuttles';
import { SignalPulseRenderer } from '../visualizer/signal-pulses';
import { mapSectors, mapCrew, computeSectorPositions } from './scene-utils';
import type { SectorState } from '../visualizer/sector-outposts';
import type { PodState } from '../visualizer/shuttles';
import { loadScSpriteSheet, isScSpriteReady, drawScSprite } from './sc-sprite-loader';

export function StarCommandScene({ className }: { className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const lastFrameRef = useRef<number>(0);
  const pendingResizeRef = useRef(false);

  const sectorStatesRef = useRef<SectorState[]>([]);
  const podStatesRef = useRef<PodState[]>([]);

  const { sectors, crewList } = useStarCommandStore();
  useEffect(() => {
    sectorStatesRef.current = mapSectors(sectors, crewList);
    podStatesRef.current = mapCrew(crewList);
  }, [sectors, crewList]);

  useEffect(() => {
    loadScSpriteSheet();

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    // --- Starfield ---
    type Star = { x: number; y: number; radius: number; phase: number; speed: number };
    const STAR_COUNT = 150;
    let stars: Star[] = [];

    const scatterStars = (w: number, h: number) => {
      stars = Array.from({ length: STAR_COUNT }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        radius: Math.random() * 1.2 + 0.3,
        phase: Math.random() * Math.PI * 2,
        speed: Math.random() * 0.0008 + 0.0002
      }));
    };

    let starOffscreen = new OffscreenCanvas(canvas.width, canvas.height);
    let starCtx = starOffscreen.getContext('2d')!;
    let lastStarRedraw = 0;
    let elapsed = 0;

    const redrawStars = () => {
      starCtx.clearRect(0, 0, starOffscreen.width, starOffscreen.height);
      for (const star of stars) {
        const brightness = 0.4 + 0.6 * Math.abs(Math.sin(elapsed * star.speed + star.phase));
        starCtx.beginPath();
        starCtx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        starCtx.fillStyle = `rgba(255,255,255,${brightness.toFixed(2)})`;
        starCtx.fill();
      }
    };

    const applyResize = () => {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      pendingResizeRef.current = false;
      starOffscreen = new OffscreenCanvas(canvas.width, canvas.height);
      starCtx = starOffscreen.getContext('2d')!;
      scatterStars(canvas.width, canvas.height);
      redrawStars();
    };
    applyResize();

    const ro = new ResizeObserver(() => {
      pendingResizeRef.current = true;
    });
    ro.observe(container);

    // --- Renderers ---
    const sectorOutposts = new SectorOutpostRenderer();
    const shuttleRenderer = new ShuttleRenderer();
    const signalPulses = new SignalPulseRenderer();
    let lastPulseSpawn = 0;

    let stopped = false;

    function frame(now: number) {
      if (stopped) return;
      if (pendingResizeRef.current) applyResize();

      // Adaptive FPS throttle
      const hasActiveCrew = podStatesRef.current.some(
        (p) => p.status === 'active' || p.status === 'hailing' || p.status === 'error'
      );
      const isActive =
        hasActiveCrew || shuttleRenderer.hasActiveShuttles() || signalPulses.hasActivePulses();
      const frameBudget = isActive ? 33 : 100;

      if (now - lastFrameRef.current < frameBudget) {
        rafRef.current = requestAnimationFrame(frame);
        return;
      }

      const deltaMs = lastFrameRef.current ? now - lastFrameRef.current : 16;
      lastFrameRef.current = now;
      elapsed += deltaMs;

      const w = canvas!.width;
      const h = canvas!.height;

      // Background
      ctx!.fillStyle = '#0a0a1a';
      ctx!.fillRect(0, 0, w, h);

      // Starfield
      if (now - lastStarRedraw >= 200) {
        redrawStars();
        lastStarRedraw = now;
      }
      ctx!.drawImage(starOffscreen, 0, 0);

      const cx = w / 2;
      const cy = h / 2;
      const scale = Math.min(w, h) / 600;
      const outpostRadius = Math.min(w, h) * 0.42;

      const currentSectors = sectorStatesRef.current;
      const currentPods = podStatesRef.current;
      const sectorPositions = computeSectorPositions(currentSectors, cx, cy, outpostRadius);

      // Update renderers
      shuttleRenderer.update(currentPods, sectorPositions, cx, cy, deltaMs);
      signalPulses.update(deltaMs);

      // Spawn signal pulses every 3s for hailing crew
      if (elapsed - lastPulseSpawn >= 3000) {
        for (const pod of currentPods) {
          if (pod.status === 'hailing') {
            const pos = shuttleRenderer.getShuttlePosition(pod.crewId);
            if (pos) signalPulses.addPulse(pos.x, pos.y, cx, cy);
          }
        }
        lastPulseSpawn = elapsed;
      }

      // Render layers (back to front)
      sectorOutposts.render(ctx!, currentSectors, sectorPositions, elapsed);
      signalPulses.render(ctx!, elapsed);
      shuttleRenderer.render(ctx!, elapsed);

      // Hub sprite on top
      if (isScSpriteReady()) {
        const hubSize = 128 * scale;
        ctx!.imageSmoothingEnabled = false;
        drawScSprite(
          ctx!,
          'station-hub',
          elapsed,
          cx - hubSize / 2,
          cy - hubSize / 2,
          hubSize,
          hubSize
        );
      }

      rafRef.current = requestAnimationFrame(frame);
    }

    const handleVisibility = () => {
      if (document.hidden) {
        stopped = true;
        cancelAnimationFrame(rafRef.current);
      } else {
        stopped = false;
        lastFrameRef.current = 0;
        rafRef.current = requestAnimationFrame(frame);
      }
    };
    const handleBlur = () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
    };
    const handleFocus = () => {
      if (!stopped) return;
      stopped = false;
      lastFrameRef.current = 0;
      rafRef.current = requestAnimationFrame(frame);
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    rafRef.current = requestAnimationFrame(frame);

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  return (
    <div ref={containerRef} className={`relative overflow-hidden ${className ?? ''}`}>
      <canvas ref={canvasRef} className="absolute inset-0" />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck:web 2>&1 | grep "StarCommandScene\|sector-outposts\|shuttles\|signal-pulses\|scene-utils" | head -10
```

Expected: no errors in any of our new files.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/star-command/StarCommandScene.tsx
git commit -m "feat(star-command): rewrite scene with galaxy map layout"
```

---

### Task 6: Delete old visualizer files and verify

**Files:**

- Delete: `src/renderer/src/components/visualizer/station-ring.ts`
- Delete: `src/renderer/src/components/visualizer/crew-pods.ts`
- Delete: `src/renderer/src/components/visualizer/comms-beams.ts`

- [ ] **Step 1: Delete the files**

```bash
git rm src/renderer/src/components/visualizer/station-ring.ts
git rm src/renderer/src/components/visualizer/crew-pods.ts
git rm src/renderer/src/components/visualizer/comms-beams.ts
```

- [ ] **Step 2: Run typecheck — verify no remaining references**

```bash
npm run typecheck:web 2>&1 | grep -E "station-ring|crew-pods|comms-beams"
```

Expected: no output (no errors referencing the deleted files).

- [ ] **Step 3: Run all tests**

```bash
npx vitest run src/renderer/src/components/star-command/__tests__/scene-utils.test.ts 2>&1 | tail -5
```

Expected: 10/10 PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(star-command): remove station-ring, crew-pods, comms-beams"
```

---

## Acceptance Checklist

- [ ] Dark navy canvas fills all space right of the CRT chat frame
- [ ] Twinkling starfield visible
- [ ] Station hub rotates at canvas center
- [ ] Sectors appear as animated beacon nodes with labels, spread around the canvas
- [ ] Active sectors show a teal glow under their beacon
- [ ] Active crewmates have a shuttle orbiting their sector outpost
- [ ] Hailing shuttles break orbit and fly toward the hub, then return
- [ ] Error-status shuttles orbit with jittery speed
- [ ] Complete-status triggers dock-sparkle, then shuttle disappears
- [ ] Lost-status triggers shuttle drifting away and fading out
- [ ] Hailing crew generate teal signal pulses toward hub every 3s; amber pulses return
- [ ] No StationRing arcs, no crew pod dots, no comms beams
- [ ] Scene pauses on window blur / visibility hidden
- [ ] 10fps when no activity; 30fps with active/hailing/error crew
- [ ] All 10 scene-utils tests pass
