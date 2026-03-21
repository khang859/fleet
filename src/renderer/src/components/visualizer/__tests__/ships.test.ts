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
    ...overrides
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

  it('spreads ships across viewport for multiple agents', () => {
    const sm = new ShipManager();
    const agents = [
      makeAgent({ paneId: 'pane-1' }),
      makeAgent({ paneId: 'pane-2', label: 'Agent 2' }),
      makeAgent({ paneId: 'pane-3', label: 'Agent 3' })
    ];
    sm.update(agents, 16, 400, 200);

    const ships = sm.getShips();
    expect(ships).toHaveLength(3);
    // 3 agents fit in a single row (cols=3, rows=1), so X positions increase
    expect(ships[0].targetX).toBeLessThan(ships[1].targetX);
    expect(ships[1].targetX).toBeLessThan(ships[2].targetX);
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
      subAgents: [makeAgent({ paneId: 'pane-1:sub:1', label: 'sub-agent', state: 'reading' })]
    });
    sm.update([agent], 16, 400, 200);

    const ships = sm.getShips();
    const parent = ships.find((s) => s.paneId === 'pane-1');
    const sub = ships.find((s) => s.paneId === 'pane-1:sub:1');

    expect(parent).toBeDefined();
    expect(sub).toBeDefined();
    expect(sub!.isSubAgent).toBe(true);
    expect(sub!.width).toBeLessThan(parent!.width);
    expect(sub!.targetX).toBeLessThan(parent!.targetX);
  });

  it('caps rendered subagents at 4 with overflow badge', () => {
    const sm = new ShipManager();
    const subs = Array.from({ length: 6 }, (_, i) =>
      makeAgent({ paneId: `pane-1:sub:${i}`, label: `sub-${i}`, state: 'working' })
    );
    const agent = makeAgent({ subAgents: subs });
    sm.update([agent], 16, 400, 200);

    const ships = sm.getShips();
    const subShips = ships.filter((s) => s.isSubAgent);
    expect(subShips.length).toBe(4);
    expect(subShips[3].overflowCount).toBe(2);
  });

  it('triggers warp-in on spawn and warp-out on despawn', () => {
    const sm = new ShipManager();
    sm.update([makeAgent()], 16, 400, 200);

    const ship = sm.getShips()[0];
    expect(ship.warp.isActive()).toBe(true);

    sm.update([], 16, 400, 200);
    const despawning = sm.getShips()[0];
    expect(despawning.warp.isActive()).toBe(true);
  });

  it('removes ship after warp-out completes', () => {
    const sm = new ShipManager();
    sm.update([makeAgent()], 16, 400, 200);
    sm.update([makeAgent()], 600, 400, 200);
    sm.update([], 16, 400, 200);
    sm.update([], 600, 400, 200);

    expect(sm.getShips()).toHaveLength(0);
  });

  it('hit tests by bounding box', () => {
    const sm = new ShipManager();
    // Spawn and let warp-in complete
    sm.update([makeAgent()], 16, 400, 200);
    sm.update([makeAgent()], 600, 400, 200);
    // Run frames to let position converge
    for (let i = 0; i < 300; i++) {
      sm.update([makeAgent()], 16, 400, 200);
    }

    // Ship drifts around its target — use its actual position for hit test
    const ship = sm.getShips()[0];
    const hit = sm.hitTest(ship.currentX, ship.currentY, 400, 200);
    expect(hit).toBe('pane-1');

    // Far away should miss
    const miss = sm.hitTest(0, 0, 400, 200);
    expect(miss).toBeNull();
  });
});
