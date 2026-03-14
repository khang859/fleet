# Space Visualizer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the renderer-side space visualizer for Fleet's agent visualizer (Chunk 4), replacing the pixel-art office scene with a scrolling starfield and spaceship theme.

**Architecture:** The main-process agent tracking (Tasks 4.1–4.3 from the original plan) feeds `AgentVisualState[]` to the renderer via IPC. The renderer visualization is a canvas-based scene with a parallax starfield, procedurally drawn pixel-art spaceships, engine trail particles, and warp effects. A Zustand store bridges IPC data to the React canvas component. The visualizer mounts in a toggleable drawer/tab panel.

**Tech Stack:** React, TypeScript, Canvas 2D API, Zustand, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-03-14-space-visualizer-design.md`

**Prerequisite:** Tasks 4.1–4.3 from `docs/superpowers/plans/2026-03-14-fleet-implementation.md` must be completed first (JSONL watcher, agent state tracker, main process wiring). The IPC channel `agent:state` and preload bridge `window.fleet.agentState.onStateUpdate` are already wired.

---

## File Structure

```
src/renderer/
  store/
    visualizer-store.ts              # Zustand store: agents[], isVisible, panelMode

  components/visualizer/
    starfield.ts                     # Parallax star layer system (3 layers, scrolling)
    ships.ts                         # Ship state machine, positioning, subagent trailing
    particles.ts                     # Engine trail particles + warp streak effect
    space-renderer.ts                # Canvas rendering: composes starfield, ships, particles
    SpaceCanvas.tsx                  # React component: game loop, click/hover, tooltip
    VisualizerPanel.tsx              # Toggleable drawer/tab panel wrapping SpaceCanvas
```

Modifications:
- `src/renderer/src/App.tsx` — mount VisualizerPanel, subscribe to agent state IPC
- `src/renderer/src/hooks/use-pane-navigation.ts` — add Cmd+Shift+V shortcut

---

## Chunk 1: Visualizer Store & Starfield

### Task 1: Visualizer store (renderer)

**Files:**
- Create: `src/renderer/src/store/visualizer-store.ts`

- [ ] **Step 1: Write the visualizer store**

Create `src/renderer/src/store/visualizer-store.ts`:
```ts
import { create } from 'zustand';
import type { AgentVisualState } from '../../../shared/types';

type VisualizerStore = {
  agents: AgentVisualState[];
  isVisible: boolean;
  panelMode: 'drawer' | 'tab';

  setAgents: (agents: AgentVisualState[]) => void;
  toggleVisible: () => void;
  setPanelMode: (mode: 'drawer' | 'tab') => void;
};

export const useVisualizerStore = create<VisualizerStore>((set) => ({
  agents: [],
  isVisible: false,
  panelMode: 'drawer',

  setAgents: (agents) => set({ agents }),
  toggleVisible: () => set((state) => ({ isVisible: !state.isVisible })),
  setPanelMode: (mode) => set({ panelMode: mode }),
}));
```

- [ ] **Step 2: Wire IPC to update store**

In `src/renderer/src/App.tsx`, add import:
```ts
import { useVisualizerStore } from './store/visualizer-store';
```

Inside the `App` component, add the subscription effect:
```ts
const { setAgents } = useVisualizerStore();

useEffect(() => {
  const cleanup = window.fleet.agentState.onStateUpdate(({ states }) => {
    setAgents(states);
  });
  return cleanup;
}, [setAgents]);
```

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/store/visualizer-store.ts src/renderer/src/App.tsx
git commit -m "feat: add visualizer store with IPC-driven agent state updates"
```

### Task 2: Starfield system

**Files:**
- Create: `src/renderer/src/components/visualizer/starfield.ts`
- Create: `src/renderer/src/components/visualizer/__tests__/starfield.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/visualizer/__tests__/starfield.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { Starfield, StarLayer } from '../starfield';

describe('Starfield', () => {
  it('creates 3 layers with correct star counts for a given area', () => {
    const sf = new Starfield(200, 100);
    const layers = sf.getLayers();

    expect(layers).toHaveLength(3);
    // Far layer: ~10 base stars scaled to area
    expect(layers[0].stars.length).toBeGreaterThan(0);
    // Mid layer
    expect(layers[1].stars.length).toBeGreaterThan(0);
    // Near layer: most stars
    expect(layers[2].stars.length).toBeGreaterThanOrEqual(layers[0].stars.length);
  });

  it('scrolls stars left and wraps around', () => {
    const sf = new Starfield(100, 100);
    const layers = sf.getLayers();
    const firstStarX = layers[2].stars[0].x;

    sf.update(1000); // 1 second

    const newX = layers[2].stars[0].x;
    // Near layer moves fastest, so x should have decreased
    expect(newX).not.toBe(firstStarX);
  });

  it('stars that scroll off-screen wrap to the right', () => {
    const sf = new Starfield(100, 100);
    const layers = sf.getLayers();

    // Force a star to the left edge
    layers[2].stars[0].x = -1;
    sf.update(0);

    // After update with 0 delta, the wrap should reposition it
    // (wrap happens inside update)
    sf.update(16);
    // Star should have wrapped to right side or still be updating
    // The key invariant: no star has x < -5 (buffer)
    for (const star of layers[2].stars) {
      expect(star.x).toBeGreaterThan(-10);
    }
  });

  it('persists star positions across resize', () => {
    const sf = new Starfield(200, 100);
    const countBefore = sf.getLayers()[0].stars.length;

    sf.resize(400, 200);
    const countAfter = sf.getLayers()[0].stars.length;

    // More area = more stars
    expect(countAfter).toBeGreaterThanOrEqual(countBefore);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts
```

Expected: FAIL — `Cannot find module '../starfield'`

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/components/visualizer/starfield.ts`:
```ts
export type Star = {
  x: number;
  y: number;
  size: number;
  brightness: number;
};

export type StarLayer = {
  stars: Star[];
  speed: number; // pixels per second (scrolls left)
  brightness: number; // 0-1 base brightness
  size: number; // base dot size in px
};

const LAYER_CONFIGS = [
  { speed: 5, brightness: 0.3, size: 1, density: 10 },  // far
  { speed: 15, brightness: 0.6, size: 1.5, density: 20 }, // mid
  { speed: 30, brightness: 0.9, size: 2, density: 30 },  // near
];

// Reference area for density scaling (roughly a small panel)
const REF_AREA = 200 * 100;

export class Starfield {
  private layers: StarLayer[] = [];
  private width: number;
  private height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.initLayers();
  }

  private initLayers(): void {
    this.layers = LAYER_CONFIGS.map((config) => {
      const areaScale = Math.max(1, Math.sqrt((this.width * this.height) / REF_AREA));
      const count = Math.round(config.density * areaScale);
      const stars: Star[] = [];

      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          size: config.size + (Math.random() - 0.5) * 0.5,
          brightness: config.brightness + (Math.random() - 0.5) * 0.15,
        });
      }

      return {
        stars,
        speed: config.speed,
        brightness: config.brightness,
        size: config.size,
      };
    });
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;
    for (const layer of this.layers) {
      for (const star of layer.stars) {
        star.x -= layer.speed * dt;
        if (star.x < -5) {
          star.x = this.width + Math.random() * 10;
          star.y = Math.random() * this.height;
        }
      }
    }
  }

  resize(width: number, height: number): void {
    const oldWidth = this.width;
    const oldHeight = this.height;
    this.width = width;
    this.height = height;

    // Scale existing star positions and add/remove stars for new density
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const config = LAYER_CONFIGS[i];

      // Scale positions
      for (const star of layer.stars) {
        star.x = (star.x / oldWidth) * width;
        star.y = (star.y / oldHeight) * height;
      }

      // Adjust count
      const areaScale = Math.max(1, Math.sqrt((width * height) / REF_AREA));
      const targetCount = Math.round(config.density * areaScale);

      while (layer.stars.length < targetCount) {
        layer.stars.push({
          x: Math.random() * width,
          y: Math.random() * height,
          size: config.size + (Math.random() - 0.5) * 0.5,
          brightness: config.brightness + (Math.random() - 0.5) * 0.15,
        });
      }

      if (layer.stars.length > targetCount) {
        layer.stars.length = targetCount;
      }
    }
  }

  getLayers(): StarLayer[] {
    return this.layers;
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const layer of this.layers) {
      for (const star of layer.stars) {
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, Math.min(1, star.brightness))})`;
        ctx.fillRect(
          Math.round(star.x),
          Math.round(star.y),
          Math.round(star.size),
          Math.round(star.size),
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/renderer/src/components/visualizer/__tests__/starfield.test.ts
```

Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/starfield.ts src/renderer/src/components/visualizer/__tests__/starfield.test.ts
git commit -m "feat: add parallax starfield system with 3 scroll layers"
```

---

## Chunk 2: Particles & Ships

### Task 3: Particle system

**Files:**
- Create: `src/renderer/src/components/visualizer/particles.ts`
- Create: `src/renderer/src/components/visualizer/__tests__/particles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/visualizer/__tests__/particles.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ParticleSystem, WarpEffect } from '../particles';

describe('ParticleSystem', () => {
  it('spawns particles at a given position', () => {
    const ps = new ParticleSystem();
    ps.spawn(100, 50, '#4ade80', 4);

    expect(ps.getParticles()).toHaveLength(4);
  });

  it('particles drift left and fade over time', () => {
    const ps = new ParticleSystem();
    ps.spawn(100, 50, '#4ade80', 1);

    const before = { ...ps.getParticles()[0] };
    ps.update(500);
    const after = ps.getParticles()[0];

    expect(after.x).toBeLessThan(before.x);
    expect(after.opacity).toBeLessThan(before.opacity);
  });

  it('removes dead particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(100, 50, '#4ade80', 1);

    // Advance past max lifetime (1.5s)
    ps.update(2000);

    expect(ps.getParticles()).toHaveLength(0);
  });

  it('respects global particle cap of 100', () => {
    const ps = new ParticleSystem();
    for (let i = 0; i < 30; i++) {
      ps.spawn(i * 10, 50, '#4ade80', 6);
    }

    // 30 * 6 = 180, but should be capped at 100
    expect(ps.getParticles().length).toBeLessThanOrEqual(100);
  });
});

describe('WarpEffect', () => {
  it('creates a warp-in streak', () => {
    const warp = new WarpEffect();
    warp.startWarpIn(200, 50);

    expect(warp.isActive()).toBe(true);
    expect(warp.getStretch()).toBeGreaterThan(1);
  });

  it('warp-in completes after ~500ms', () => {
    const warp = new WarpEffect();
    warp.startWarpIn(200, 50);

    warp.update(600);

    expect(warp.isActive()).toBe(false);
    expect(warp.getStretch()).toBe(1);
  });

  it('creates a warp-out streak that moves right', () => {
    const warp = new WarpEffect();
    warp.startWarpOut(200, 50);

    const xBefore = warp.getX();
    warp.update(200);
    const xAfter = warp.getX();

    expect(xAfter).toBeGreaterThan(xBefore);
  });

  it('warp-out completes and signals done', () => {
    const warp = new WarpEffect();
    warp.startWarpOut(200, 50);

    warp.update(600);

    expect(warp.isActive()).toBe(false);
    expect(warp.isDone()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/renderer/src/components/visualizer/__tests__/particles.test.ts
```

Expected: FAIL — `Cannot find module '../particles'`

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/components/visualizer/particles.ts`:
```ts
const MAX_PARTICLES = 100;
const MIN_LIFETIME = 0.5; // seconds
const MAX_LIFETIME = 1.5;

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  opacity: number;
  size: number;
  color: string;
  life: number;
  maxLife: number;
};

export class ParticleSystem {
  private particles: Particle[] = [];

  spawn(x: number, y: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) {
        // Remove oldest particle to make room
        this.particles.shift();
      }

      const maxLife = MIN_LIFETIME + Math.random() * (MAX_LIFETIME - MIN_LIFETIME);
      this.particles.push({
        x,
        y: y + (Math.random() - 0.5) * 4,
        vx: -(20 + Math.random() * 30), // drift left
        vy: (Math.random() - 0.5) * 8,
        opacity: 0.8 + Math.random() * 0.2,
        size: 1 + Math.random() * 2,
        color,
        life: maxLife,
        maxLife,
      });
    }
  }

  update(deltaMs: number): void {
    const dt = deltaMs / 1000;

    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.opacity = Math.max(0, (p.life / p.maxLife) * 0.9);
    }

    this.particles = this.particles.filter((p) => p.life > 0);
  }

  getParticles(): Particle[] {
    return this.particles;
  }

  clear(): void {
    this.particles = [];
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.size), Math.round(p.size));
    }
    ctx.globalAlpha = 1;
  }
}

// Ease-out cubic: decelerates smoothly
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class WarpEffect {
  private active = false;
  private done = false;
  private mode: 'in' | 'out' = 'in';
  private elapsed = 0;
  private duration = 500; // ms
  private targetX = 0;
  private targetY = 0;
  private currentX = 0;
  private currentStretch = 1;

  startWarpIn(targetX: number, targetY: number): void {
    this.active = true;
    this.done = false;
    this.mode = 'in';
    this.elapsed = 0;
    this.targetX = targetX;
    this.targetY = targetY;
    this.currentX = -20; // start off-screen left
    this.currentStretch = 8; // stretched horizontally
  }

  startWarpOut(fromX: number, fromY: number): void {
    this.active = true;
    this.done = false;
    this.mode = 'out';
    this.elapsed = 0;
    this.targetX = fromX;
    this.targetY = fromY;
    this.currentX = fromX;
    this.currentStretch = 1;
  }

  update(deltaMs: number): void {
    if (!this.active) return;

    this.elapsed += deltaMs;
    const t = Math.min(1, this.elapsed / this.duration);

    if (this.mode === 'in') {
      const eased = easeOutCubic(t);
      this.currentX = -20 + (this.targetX + 20) * eased;
      this.currentStretch = 8 - 7 * eased; // 8 → 1
    } else {
      // Warp out: accelerate right, stretch increases
      const eased = easeOutCubic(t);
      this.currentX = this.targetX + eased * 300;
      this.currentStretch = 1 + eased * 7; // 1 → 8
    }

    if (t >= 1) {
      this.active = false;
      if (this.mode === 'in') {
        this.currentX = this.targetX;
        this.currentStretch = 1;
      } else {
        this.done = true;
      }
    }
  }

  isActive(): boolean {
    return this.active;
  }

  isDone(): boolean {
    return this.done;
  }

  getX(): number {
    return this.currentX;
  }

  getY(): number {
    return this.targetY;
  }

  getStretch(): number {
    return this.currentStretch;
  }

  render(ctx: CanvasRenderingContext2D, color: string, width: number, height: number): void {
    if (!this.active) return;

    const stretchedWidth = width * this.currentStretch;
    const x = Math.round(this.currentX - stretchedWidth / 2);
    const y = Math.round(this.targetY - height / 2);

    // Bright streak
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.round(stretchedWidth), Math.round(height));

    // Light burst at leading edge
    if (this.mode === 'in' && this.elapsed < 200) {
      const burstAlpha = 1 - this.elapsed / 200;
      ctx.globalAlpha = burstAlpha * 0.6;
      ctx.fillStyle = '#ffffff';
      const burstSize = 12;
      ctx.fillRect(
        Math.round(this.currentX - burstSize / 2),
        Math.round(this.targetY - burstSize / 2),
        burstSize,
        burstSize,
      );
    }

    ctx.globalAlpha = 1;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/renderer/src/components/visualizer/__tests__/particles.test.ts
```

Expected: PASS — 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/particles.ts src/renderer/src/components/visualizer/__tests__/particles.test.ts
git commit -m "feat: add particle system for engine trails and warp streak effects"
```

### Task 4: Ship state machine

**Files:**
- Create: `src/renderer/src/components/visualizer/ships.ts`
- Create: `src/renderer/src/components/visualizer/__tests__/ships.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/components/visualizer/__tests__/ships.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ShipManager } from '../ships';
import type { AgentVisualState } from '../../../../../shared/types';

function makeAgent(overrides: Partial<AgentVisualState> = {}): AgentVisualState {
  return {
    paneId: 'pane-1',
    label: 'Agent 1',
    state: 'working',
    subAgents: [],
    uptime: 1000,
    ...overrides,
  };
}

describe('ShipManager', () => {
  it('spawns a ship for a new agent', () => {
    const sm = new ShipManager();
    sm.update([makeAgent()], 16, 400, 200);

    const ships = sm.getShips();
    expect(ships).toHaveLength(1);
    expect(ships[0].paneId).toBe('pane-1');
  });

  it('assigns correct Y positions for multiple ships', () => {
    const sm = new ShipManager();
    const agents = [
      makeAgent({ paneId: 'pane-1' }),
      makeAgent({ paneId: 'pane-2', label: 'Agent 2' }),
      makeAgent({ paneId: 'pane-3', label: 'Agent 3' }),
    ];
    sm.update(agents, 16, 400, 200);

    const ships = sm.getShips();
    expect(ships).toHaveLength(3);

    // Ships should have increasing Y positions (normalized)
    expect(ships[0].targetY).toBeLessThan(ships[1].targetY);
    expect(ships[1].targetY).toBeLessThan(ships[2].targetY);
  });

  it('maps state to correct color', () => {
    const sm = new ShipManager();
    sm.update([makeAgent({ state: 'working' })], 16, 400, 200);
    expect(sm.getShips()[0].stateColor).toBe('#4ade80');

    sm.update([makeAgent({ state: 'reading' })], 16, 400, 200);
    expect(sm.getShips()[0].stateColor).toBe('#60a5fa');

    sm.update([makeAgent({ state: 'idle' })], 16, 400, 200);
    expect(sm.getShips()[0].stateColor).toBe('#9ca3af');

    sm.update([makeAgent({ state: 'needs-permission' })], 16, 400, 200);
    expect(sm.getShips()[0].stateColor).toBe('#fbbf24');

    sm.update([makeAgent({ state: 'waiting' })], 16, 400, 200);
    expect(sm.getShips()[0].stateColor).toBe('#34d399');
  });

  it('treats walking as idle', () => {
    const sm = new ShipManager();
    sm.update([makeAgent({ state: 'walking' })], 16, 400, 200);
    expect(sm.getShips()[0].stateColor).toBe('#9ca3af');
  });

  it('does not create ships for not-agent state', () => {
    const sm = new ShipManager();
    sm.update([makeAgent({ state: 'not-agent' })], 16, 400, 200);
    expect(sm.getShips()).toHaveLength(0);
  });

  it('creates smaller trailing ships for subagents', () => {
    const sm = new ShipManager();
    const agent = makeAgent({
      subAgents: [
        makeAgent({ paneId: 'pane-1:sub:1', label: 'sub-agent', state: 'reading' }),
      ],
    });
    sm.update([agent], 16, 400, 200);

    const ships = sm.getShips();
    const parent = ships.find((s) => s.paneId === 'pane-1');
    const sub = ships.find((s) => s.paneId === 'pane-1:sub:1');

    expect(parent).toBeDefined();
    expect(sub).toBeDefined();
    expect(sub!.isSubAgent).toBe(true);
    expect(sub!.width).toBeLessThan(parent!.width);
    // Sub trails behind parent (lower X in normalized coords)
    expect(sub!.targetX).toBeLessThan(parent!.targetX);
  });

  it('caps rendered subagents at 4 with overflow badge', () => {
    const sm = new ShipManager();
    const subs = Array.from({ length: 6 }, (_, i) =>
      makeAgent({ paneId: `pane-1:sub:${i}`, label: `sub-${i}`, state: 'working' }),
    );
    const agent = makeAgent({ subAgents: subs });
    sm.update([agent], 16, 400, 200);

    const ships = sm.getShips();
    const subShips = ships.filter((s) => s.isSubAgent);
    // 4 rendered + parent = 5 total, but only 4 sub-ships
    expect(subShips.length).toBe(4);
    // Last sub should have overflow badge
    expect(subShips[3].overflowCount).toBe(2);
  });

  it('triggers warp-in on spawn and warp-out on despawn', () => {
    const sm = new ShipManager();
    sm.update([makeAgent()], 16, 400, 200);

    const ship = sm.getShips()[0];
    expect(ship.warp.isActive()).toBe(true); // warp-in in progress

    // Remove the agent
    sm.update([], 16, 400, 200);
    const despawning = sm.getShips()[0];
    expect(despawning.warp.isActive()).toBe(true); // warp-out
  });

  it('removes ship after warp-out completes', () => {
    const sm = new ShipManager();
    sm.update([makeAgent()], 16, 400, 200);

    // Complete warp-in
    sm.update([makeAgent()], 600, 400, 200);

    // Remove agent, start warp-out
    sm.update([], 16, 400, 200);

    // Complete warp-out
    sm.update([], 600, 400, 200);

    expect(sm.getShips()).toHaveLength(0);
  });

  it('hit tests by bounding box', () => {
    const sm = new ShipManager();
    sm.update([makeAgent()], 600, 400, 200); // let warp-in finish

    const hit = sm.hitTest(400 * 0.35, 200 * 0.15, 400, 200);
    expect(hit).toBe('pane-1');

    const miss = sm.hitTest(0, 0, 400, 200);
    expect(miss).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run src/renderer/src/components/visualizer/__tests__/ships.test.ts
```

Expected: FAIL — `Cannot find module '../ships'`

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/components/visualizer/ships.ts`:
```ts
import type { AgentVisualState } from '../../../../shared/types';
import { WarpEffect } from './particles';

const STATE_COLORS: Record<string, string> = {
  working: '#4ade80',
  reading: '#60a5fa',
  idle: '#9ca3af',
  walking: '#9ca3af',
  'needs-permission': '#fbbf24',
  waiting: '#34d399',
  'not-agent': '#9ca3af',
};

const ACCENT_PALETTES = [
  '#f87171', // red
  '#fb923c', // orange
  '#a78bfa', // purple
  '#f472b6', // pink
  '#2dd4bf', // cyan
  '#facc15', // yellow
];

const BASE_X = 0.35;
const Y_START = 0.15;
const Y_RANGE = 0.7;
const PARENT_WIDTH = 16;
const PARENT_HEIGHT = 24;
const SUB_WIDTH = 10;
const SUB_HEIGHT = 15;
const MAX_RENDERED_SUBS = 4;
const SUB_OFFSET_X = -0.06;
const SUB_OFFSET_Y = 0.04;

export type Ship = {
  paneId: string;
  label: string;
  state: AgentVisualState['state'];
  currentTool?: string;
  uptime: number;
  stateColor: string;
  accentColor: string;
  targetX: number;
  targetY: number;
  currentX: number;
  currentY: number;
  width: number;
  height: number;
  isSubAgent: boolean;
  overflowCount: number;
  warp: WarpEffect;
  despawning: boolean;
  spawnDelay: number; // ms delay before warp-in starts (for staggering)
  spawnDelayElapsed: number;
  pulsePhase: number; // for needs-permission pulsing glow
};

export class ShipManager {
  private ships = new Map<string, Ship>();
  private spawnOrder: string[] = []; // tracks order for Y assignment
  private nextSpawnDelay = 0; // accumulates stagger delay

  update(agents: AgentVisualState[], deltaMs: number, canvasW: number, canvasH: number): void {
    const activeIds = new Set<string>();

    // Filter out not-agent
    const visibleAgents = agents.filter((a) => a.state !== 'not-agent');

    // Recalculate Y positions based on current count
    const ySpacing = visibleAgents.length > 1
      ? Y_RANGE / (visibleAgents.length - 1)
      : 0;

    // Spawn / update parent ships
    for (let i = 0; i < visibleAgents.length; i++) {
      const agent = visibleAgents[i];
      activeIds.add(agent.paneId);
      const targetY = visibleAgents.length === 1
        ? Y_START + Y_RANGE / 2
        : Y_START + i * ySpacing;

      if (!this.ships.has(agent.paneId)) {
        this.spawnShip(agent, i, targetY, canvasW, canvasH);
      } else {
        this.updateShip(agent, targetY, canvasW, canvasH);
      }

      // Handle subagents
      const maxSubs = Math.min(agent.subAgents.length, MAX_RENDERED_SUBS);
      for (let si = 0; si < maxSubs; si++) {
        const sub = agent.subAgents[si];
        activeIds.add(sub.paneId);

        const subTargetX = BASE_X + (si + 1) * SUB_OFFSET_X;
        const subTargetY = targetY + (si + 1) * SUB_OFFSET_Y;

        if (!this.ships.has(sub.paneId)) {
          this.spawnSubShip(sub, agent.paneId, si, subTargetX, subTargetY, canvasW, canvasH);
        } else {
          this.updateShip(sub, subTargetY, canvasW, canvasH);
        }

        // Mark overflow on last rendered sub
        if (si === maxSubs - 1 && agent.subAgents.length > MAX_RENDERED_SUBS) {
          const shipRef = this.ships.get(sub.paneId);
          if (shipRef) shipRef.overflowCount = agent.subAgents.length - MAX_RENDERED_SUBS;
        }
      }

      // Despawn subs that are no longer in the agent's subAgents list
      const activeSubIds = new Set(agent.subAgents.slice(0, MAX_RENDERED_SUBS).map((s) => s.paneId));
      for (const [id, ship] of this.ships) {
        if (ship.isSubAgent && id.startsWith(agent.paneId + ':sub:') && !activeSubIds.has(id)) {
          if (!ship.despawning) {
            ship.despawning = true;
            ship.warp.startWarpOut(ship.currentX, ship.currentY);
          }
        }
      }
    }

    // Despawn removed ships (parents and orphaned subagents)
    for (const [id, ship] of this.ships) {
      if (!activeIds.has(id) && !ship.despawning) {
        ship.despawning = true;
        ship.warp.startWarpOut(
          ship.currentX || ship.targetX * canvasW,
          ship.currentY || ship.targetY * canvasH,
        );
      }
    }

    // Animate all ships
    for (const ship of this.ships.values()) {
      // Handle spawn delay staggering
      if (ship.spawnDelayElapsed < ship.spawnDelay) {
        ship.spawnDelayElapsed += deltaMs;
        if (ship.spawnDelayElapsed >= ship.spawnDelay) {
          // Now start the actual warp-in
          ship.warp.startWarpIn(
            ship.targetX * canvasW,
            ship.targetY * canvasH,
          );
        }
        continue;
      }

      ship.warp.update(deltaMs);

      // Smoothly interpolate to target position
      if (!ship.warp.isActive() && !ship.despawning) {
        const tx = ship.targetX * canvasW;
        const ty = ship.targetY * canvasH;
        ship.currentX += (tx - ship.currentX) * 0.05;
        ship.currentY += (ty - ship.currentY) * 0.05;
      } else if (ship.warp.isActive()) {
        ship.currentX = ship.warp.getX();
        ship.currentY = ship.warp.getY();
      }

      // Pulse phase for needs-permission
      ship.pulsePhase += deltaMs * 0.005;
    }

    // Remove fully warped-out ships
    for (const [id, ship] of this.ships) {
      if (ship.despawning && ship.warp.isDone()) {
        this.ships.delete(id);
        const idx = this.spawnOrder.indexOf(id);
        if (idx !== -1) this.spawnOrder.splice(idx, 1);
      }
    }

    // Reset stagger delay after this batch
    this.nextSpawnDelay = 0;
  }

  getShips(): Ship[] {
    return Array.from(this.ships.values());
  }

  hitTest(pixelX: number, pixelY: number, canvasW: number, canvasH: number): string | null {
    // Check in reverse order (topmost first)
    const ships = this.getShips().reverse();
    for (const ship of ships) {
      if (ship.despawning) continue;

      const sx = ship.currentX - ship.width / 2;
      const sy = ship.currentY - ship.height / 2;

      if (
        pixelX >= sx && pixelX <= sx + ship.width &&
        pixelY >= sy && pixelY <= sy + ship.height
      ) {
        return ship.paneId;
      }
    }
    return null;
  }

  clearAll(): void {
    // Warp-out all ships simultaneously (workspace switch)
    for (const ship of this.ships.values()) {
      if (!ship.despawning) {
        ship.despawning = true;
        ship.warp.startWarpOut(ship.currentX, ship.currentY);
      }
    }
    this.spawnOrder = [];
  }

  private spawnShip(
    agent: AgentVisualState,
    index: number,
    targetY: number,
    canvasW: number,
    canvasH: number,
  ): void {
    const warp = new WarpEffect();
    const delay = this.nextSpawnDelay;
    this.nextSpawnDelay += 100;

    const ship: Ship = {
      paneId: agent.paneId,
      label: agent.label,
      state: agent.state,
      currentTool: agent.currentTool,
      uptime: agent.uptime,
      stateColor: STATE_COLORS[agent.state] ?? '#9ca3af',
      accentColor: this.getAccentColor(index),
      targetX: BASE_X,
      targetY,
      currentX: -20,
      currentY: targetY * canvasH,
      width: PARENT_WIDTH,
      height: PARENT_HEIGHT,
      isSubAgent: false,
      overflowCount: 0,
      warp,
      despawning: false,
      spawnDelay: delay,
      spawnDelayElapsed: 0,
      pulsePhase: 0,
    };

    // If no delay, start warp immediately
    if (delay === 0) {
      warp.startWarpIn(BASE_X * canvasW, targetY * canvasH);
    }

    this.ships.set(agent.paneId, ship);
    this.spawnOrder.push(agent.paneId);
  }

  private spawnSubShip(
    sub: AgentVisualState,
    parentPaneId: string,
    subIndex: number,
    targetX: number,
    targetY: number,
    canvasW: number,
    canvasH: number,
  ): void {
    const parent = this.ships.get(parentPaneId);
    const parentIndex = this.spawnOrder.indexOf(parentPaneId);
    const accentColor = parent
      ? this.shiftHue(parent.accentColor, 60)
      : this.getAccentColor(parentIndex);

    const warp = new WarpEffect();
    warp.startWarpIn(targetX * canvasW, targetY * canvasH);

    this.ships.set(sub.paneId, {
      paneId: sub.paneId,
      label: sub.label,
      state: sub.state,
      currentTool: sub.currentTool,
      uptime: sub.uptime,
      stateColor: STATE_COLORS[sub.state] ?? '#9ca3af',
      accentColor,
      targetX,
      targetY,
      currentX: -20,
      currentY: targetY * canvasH,
      width: SUB_WIDTH,
      height: SUB_HEIGHT,
      isSubAgent: true,
      overflowCount: 0,
      warp,
      despawning: false,
      spawnDelay: 0,
      spawnDelayElapsed: 0,
      pulsePhase: 0,
    });
  }

  private updateShip(agent: AgentVisualState, targetY: number, canvasW: number, canvasH: number): void {
    const ship = this.ships.get(agent.paneId);
    if (!ship || ship.despawning) return;

    ship.state = agent.state;
    ship.stateColor = STATE_COLORS[agent.state] ?? '#9ca3af';
    ship.currentTool = agent.currentTool;
    ship.label = agent.label;
    ship.uptime = agent.uptime;
    ship.targetY = targetY;
    ship.overflowCount = 0; // reset, will be set by parent loop if needed
  }

  private getAccentColor(index: number): string {
    if (index < ACCENT_PALETTES.length) {
      return ACCENT_PALETTES[index];
    }
    return this.shiftHue(ACCENT_PALETTES[0], ((index - ACCENT_PALETTES.length) * 60 + 30) % 360);
  }

  private shiftHue(hex: string, degrees: number): string {
    // Simple hue shift: parse hex, rotate in HSL space
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) return hex; // achromatic

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    let h = 0;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;

    h = ((h * 360 + degrees) % 360) / 360;

    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const rr = Math.round(hue2rgb(p, q, h + 1 / 3) * 255);
    const gg = Math.round(hue2rgb(p, q, h) * 255);
    const bb = Math.round(hue2rgb(p, q, h - 1 / 3) * 255);

    return `#${rr.toString(16).padStart(2, '0')}${gg.toString(16).padStart(2, '0')}${bb.toString(16).padStart(2, '0')}`;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run src/renderer/src/components/visualizer/__tests__/ships.test.ts
```

Expected: PASS — 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/visualizer/ships.ts src/renderer/src/components/visualizer/__tests__/ships.test.ts
git commit -m "feat: add ship manager with positioning, subagent trailing, warp effects, and hit testing"
```

---

## Chunk 3: Renderer, Canvas Component & Panel

### Task 5: Space renderer (canvas compositor)

**Files:**
- Create: `src/renderer/src/components/visualizer/space-renderer.ts`

- [ ] **Step 1: Write the space renderer**

Create `src/renderer/src/components/visualizer/space-renderer.ts`:
```ts
import type { Ship } from './ships';
import { ParticleSystem } from './particles';

// Engine trail spawn rates per state
const TRAIL_RATES: Record<string, { count: number; interval: number }> = {
  working: { count: 5, interval: 80 },
  reading: { count: 3, interval: 120 },
  idle: { count: 0, interval: 0 },
  walking: { count: 0, interval: 0 },
  'needs-permission': { count: 1, interval: 200 },
  waiting: { count: 2, interval: 150 },
  'not-agent': { count: 0, interval: 0 },
};

export class SpaceRenderer {
  private particles = new ParticleSystem();
  private trailTimers = new Map<string, number>();

  get particleSystem(): ParticleSystem {
    return this.particles;
  }

  updateTrails(ships: Ship[], deltaMs: number): void {
    for (const ship of ships) {
      if (ship.despawning || ship.warp.isActive()) continue;

      const rate = TRAIL_RATES[ship.state] ?? TRAIL_RATES.idle;
      if (rate.count === 0) continue;

      const timer = (this.trailTimers.get(ship.paneId) ?? 0) + deltaMs;
      if (timer >= rate.interval) {
        // Spawn particles behind the ship (left edge)
        this.particles.spawn(
          ship.currentX - ship.width / 2 - 2,
          ship.currentY,
          ship.stateColor,
          rate.count,
        );
        this.trailTimers.set(ship.paneId, 0);
      } else {
        this.trailTimers.set(ship.paneId, timer);
      }
    }

    this.particles.update(deltaMs);
  }

  render(ctx: CanvasRenderingContext2D, ships: Ship[]): void {
    ctx.imageSmoothingEnabled = false;

    // Render particles (behind ships)
    this.particles.render(ctx);

    // Render ships sorted by Y (back to front)
    const sorted = [...ships].sort((a, b) => a.currentY - b.currentY);
    for (const ship of sorted) {
      this.renderShip(ctx, ship);
    }
  }

  private renderShip(ctx: CanvasRenderingContext2D, ship: Ship): void {
    // If warp is active, render the warp streak instead of the ship
    if (ship.warp.isActive()) {
      ship.warp.render(ctx, ship.stateColor, ship.width, ship.height);
      return;
    }

    if (ship.despawning) return; // warp done but not yet cleaned up

    const x = Math.round(ship.currentX - ship.width / 2);
    const y = Math.round(ship.currentY - ship.height / 2);
    const w = ship.width;
    const h = ship.height;

    ctx.save();

    // Needs-permission pulsing glow
    if (ship.state === 'needs-permission') {
      const pulse = 0.3 + Math.sin(ship.pulsePhase) * 0.3;
      ctx.shadowColor = ship.stateColor;
      ctx.shadowBlur = 8 * pulse;
    }

    // Ship body (state color)
    ctx.fillStyle = ship.stateColor;

    // Draw a simple pixel-art ship shape:
    // Pointed nose on the right, flat rear on the left
    //   ##
    // ####
    // ######
    // ####
    //   ##
    const cx = x + w / 2;
    const cy = y + h / 2;

    ctx.beginPath();
    ctx.moveTo(x + w, cy);           // nose (right)
    ctx.lineTo(x + w * 0.3, y);      // top-left
    ctx.lineTo(x, y + h * 0.25);     // rear top
    ctx.lineTo(x, y + h * 0.75);     // rear bottom
    ctx.lineTo(x + w * 0.3, y + h);  // bottom-left
    ctx.closePath();
    ctx.fill();

    // Accent stripe (cockpit / wing marking)
    ctx.fillStyle = ship.accentColor;
    ctx.fillRect(
      Math.round(x + w * 0.4),
      Math.round(cy - 1),
      Math.round(w * 0.3),
      2,
    );

    // Engine glow (accent color, at rear)
    ctx.fillStyle = ship.accentColor;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(x - 2, Math.round(cy - 2), 3, 4);
    ctx.globalAlpha = 1;

    ctx.restore();

    // Overflow badge for subagents
    if (ship.overflowCount > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '8px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${ship.overflowCount}`, x + w + 2, cy);
    }
  }

  clearTrails(): void {
    this.particles.clear();
    this.trailTimers.clear();
  }
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/space-renderer.ts
git commit -m "feat: add space renderer with ship drawing, engine trails, and warp effects"
```

### Task 6: SpaceCanvas React component

**Files:**
- Create: `src/renderer/src/components/visualizer/SpaceCanvas.tsx`

- [ ] **Step 1: Write the SpaceCanvas component**

Create `src/renderer/src/components/visualizer/SpaceCanvas.tsx`:
```tsx
import { useRef, useEffect, useCallback, useState } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { Starfield } from './starfield';
import { ShipManager } from './ships';
import { SpaceRenderer } from './space-renderer';

type Tooltip = {
  x: number;
  y: number;
  label: string;
  tool: string;
  uptime: string;
};

type SpaceCanvasProps = {
  onShipClick: (paneId: string) => void;
};

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

const BG_COLOR = '#0a0a1a';

export function SpaceCanvas({ onShipClick }: SpaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const starfieldRef = useRef<Starfield | null>(null);
  const shipManagerRef = useRef(new ShipManager());
  const spaceRendererRef = useRef(new SpaceRenderer());
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const { agents, isVisible } = useVisualizerStore();

  // Keep agents in a ref so the game loop doesn't restart on every IPC update
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  // Game loop — only restarts when visibility changes
  useEffect(() => {
    if (!isVisible) {
      cancelAnimationFrame(animFrameRef.current);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Initialize starfield on first visible render
    if (!starfieldRef.current) {
      starfieldRef.current = new Starfield(canvas.clientWidth, canvas.clientHeight);
    }

    const starfield = starfieldRef.current;
    const shipManager = shipManagerRef.current;
    const spaceRenderer = spaceRendererRef.current;

    function loop(timestamp: number) {
      const deltaMs = lastTimeRef.current ? timestamp - lastTimeRef.current : 16;
      lastTimeRef.current = timestamp;

      const dpr = window.devicePixelRatio || 1;
      const cw = canvas!.clientWidth;
      const ch = canvas!.clientHeight;

      // Update canvas resolution for DPI scaling
      const targetW = Math.round(cw * dpr);
      const targetH = Math.round(ch * dpr);
      if (canvas!.width !== targetW || canvas!.height !== targetH) {
        canvas!.width = targetW;
        canvas!.height = targetH;
        starfield.resize(cw, ch);
      }

      // Scale context for DPI, then render in CSS-pixel space
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Update systems (use ref to avoid stale closure)
      starfield.update(deltaMs);
      shipManager.update(agentsRef.current, deltaMs, cw, ch);
      spaceRenderer.updateTrails(shipManager.getShips(), deltaMs);

      // Clear and render
      ctx!.fillStyle = BG_COLOR;
      ctx!.fillRect(0, 0, cw, ch);

      starfield.render(ctx!);
      spaceRenderer.render(ctx!, shipManager.getShips());

      animFrameRef.current = requestAnimationFrame(loop);
    }

    animFrameRef.current = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animFrameRef.current);
  }, [isVisible]);

  // Click handling
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = shipManagerRef.current.hitTest(x, y, canvas.width, canvas.height);
      if (hit) {
        onShipClick(hit);
      }
    },
    [onShipClick],
  );

  // Hover handling for tooltips
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const hit = shipManagerRef.current.hitTest(x, y, canvas.width, canvas.height);
      if (hit) {
        const ship = shipManagerRef.current.getShips().find((s) => s.paneId === hit);
        if (ship) {
          // Keep tooltip within canvas bounds
          const tooltipX = Math.min(x, rect.width - 160);
          const tooltipY = Math.max(y - 60, 0);
          setTooltip({
            x: tooltipX,
            y: tooltipY,
            label: ship.label,
            tool: ship.currentTool ?? 'none',
            uptime: formatUptime(ship.uptime),
          });
          return;
        }
      }
      setTooltip(null);
    },
    [],
  );

  return (
    <div className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setTooltip(null)}
        className="w-full h-full cursor-pointer"
        style={{ imageRendering: 'pixelated' }}
      />
      {tooltip && (
        <div
          className="absolute pointer-events-none bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-xs text-white shadow-lg z-10"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="font-medium">{tooltip.label}</div>
          <div className="text-neutral-400">Tool: {tooltip.tool}</div>
          <div className="text-neutral-400">Uptime: {tooltip.uptime}</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/visualizer/SpaceCanvas.tsx
git commit -m "feat: add SpaceCanvas React component with game loop, tooltips, and click-to-focus"
```

### Task 7: VisualizerPanel and wiring

**Files:**
- Create: `src/renderer/src/components/visualizer/VisualizerPanel.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/hooks/use-pane-navigation.ts`

- [ ] **Step 1: Write the VisualizerPanel component**

Create `src/renderer/src/components/visualizer/VisualizerPanel.tsx`:
```tsx
import { useState, useCallback } from 'react';
import { useVisualizerStore } from '../../store/visualizer-store';
import { SpaceCanvas } from './SpaceCanvas';

type VisualizerPanelProps = {
  onShipClick: (paneId: string) => void;
};

export function VisualizerPanel({ onShipClick }: VisualizerPanelProps) {
  const { isVisible, panelMode } = useVisualizerStore();
  const [drawerHeight, setDrawerHeight] = useState(200);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = drawerHeight;

    function onMove(moveEvent: PointerEvent) {
      const delta = startY - moveEvent.clientY;
      setDrawerHeight(Math.max(100, Math.min(600, startHeight + delta)));
    }

    function onUp() {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, [drawerHeight]);

  if (!isVisible) return null;

  if (panelMode === 'drawer') {
    return (
      <div className="border-t border-neutral-800 bg-[#0a0a1a]" style={{ height: `${drawerHeight}px` }}>
        <div
          className="h-1 cursor-row-resize bg-neutral-800 hover:bg-blue-500 transition-colors"
          onPointerDown={handleResizeStart}
        />
        <div className="flex items-center justify-between px-3 py-1 border-b border-neutral-800">
          <span className="text-xs text-neutral-500 uppercase tracking-wider">Fleet Visualizer</span>
        </div>
        <div className="h-[calc(100%-32px)]">
          <SpaceCanvas onShipClick={onShipClick} />
        </div>
      </div>
    );
  }

  // Tab mode — full height
  return (
    <div className="flex-1 bg-[#0a0a1a]">
      <SpaceCanvas onShipClick={onShipClick} />
    </div>
  );
}
```

- [ ] **Step 2: Add VisualizerPanel to App.tsx**

In `src/renderer/src/App.tsx`, add import:
```ts
import { VisualizerPanel } from './components/visualizer/VisualizerPanel';
```

Add inside the `App` component's return, after the `<main>` section and before the closing `</div>`:
```tsx
<VisualizerPanel
  onShipClick={(paneId) => {
    setActivePane(paneId);
    window.fleet.notifications.paneFocused({ paneId });
  }}
/>
```

- [ ] **Step 3: Add Cmd+Shift+V toggle shortcut**

In `src/renderer/src/hooks/use-pane-navigation.ts`, add import:
```ts
import { useVisualizerStore } from '../store/visualizer-store';
```

Add inside `handleKeyDown`:
```ts
      if (mod && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        useVisualizerStore.getState().toggleVisible();
      }
```

- [ ] **Step 4: Type-check**

Run:
```bash
npx tsc --noEmit
```

Expected: TypeScript compiler exits with code 0.

- [ ] **Step 5: Run the app and test**

Run:
```bash
npm run dev
```

Expected: `Cmd+Shift+V` toggles the visualizer drawer at the bottom. The starfield scrolls. If agents are running (Claude Code in a pane), ships appear with warp-in animation. Clicking a ship focuses the corresponding terminal pane. Hover shows tooltip with label, tool, and uptime.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/visualizer/VisualizerPanel.tsx src/renderer/src/App.tsx src/renderer/src/hooks/use-pane-navigation.ts
git commit -m "feat: add visualizer panel with space canvas, Cmd+Shift+V toggle, and click-to-focus"
```
