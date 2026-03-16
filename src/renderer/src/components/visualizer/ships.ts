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
  '#f87171', '#fb923c', '#a78bfa', '#f472b6', '#2dd4bf', '#facc15',
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
export const HULL_COUNT = 5;

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
  spawnDelay: number;
  spawnDelayElapsed: number;
  hullVariant: number;
  pulsePhase: number;
  // Organic drift
  driftPhaseX: number;
  driftPhaseY: number;
  driftSpeedX: number;
  driftSpeedY: number;
};

export class ShipManager {
  private ships = new Map<string, Ship>();
  private spawnOrder: string[] = [];
  private nextSpawnDelay = 0;

  update(agents: AgentVisualState[], deltaMs: number, canvasW: number, canvasH: number): void {
    const activeIds = new Set<string>();
    const visibleAgents = agents.filter((a) => a.state !== 'not-agent');

    const ySpacing = visibleAgents.length > 1
      ? Y_RANGE / (visibleAgents.length - 1)
      : 0;

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

        if (si === maxSubs - 1 && agent.subAgents.length > MAX_RENDERED_SUBS) {
          const shipRef = this.ships.get(sub.paneId);
          if (shipRef) shipRef.overflowCount = agent.subAgents.length - MAX_RENDERED_SUBS;
        }
      }

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

    // Despawn removed ships (parents AND orphaned subagents)
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
      if (ship.spawnDelayElapsed < ship.spawnDelay) {
        ship.spawnDelayElapsed += deltaMs;
        if (ship.spawnDelayElapsed >= ship.spawnDelay) {
          ship.warp.startWarpIn(
            ship.targetX * canvasW,
            ship.targetY * canvasH,
          );
        }
        continue;
      }

      ship.warp.update(deltaMs);

      if (!ship.warp.isActive() && !ship.despawning) {
        // Advance drift phases (slow frequencies for smooth arcs)
        ship.driftPhaseX += ship.driftSpeedX * deltaMs * 0.001;
        ship.driftPhaseY += ship.driftSpeedY * deltaMs * 0.001;

        // Layered sine waves for organic, smooth movement
        const isActive = ship.state === 'working' || ship.state === 'reading';
        const driftAmountX = isActive ? 18 : 30;
        const driftAmountY = isActive ? 10 : 22;

        const driftX = Math.sin(ship.driftPhaseX) * driftAmountX
          + Math.sin(ship.driftPhaseX * 0.37) * driftAmountX * 0.4;
        const driftY = Math.sin(ship.driftPhaseY) * driftAmountY
          + Math.sin(ship.driftPhaseX * 0.53) * driftAmountY * 0.3
          + Math.cos(ship.driftPhaseY * 0.71) * driftAmountY * 0.2;

        const tx = ship.targetX * canvasW + driftX;
        const ty = ship.targetY * canvasH + driftY;
        // Very soft lerp for buttery smoothness
        const lerp = 1 - Math.pow(0.97, deltaMs / 16);
        ship.currentX += (tx - ship.currentX) * lerp;
        ship.currentY += (ty - ship.currentY) * lerp;
      } else if (ship.warp.isActive()) {
        ship.currentX = ship.warp.getX();
        ship.currentY = ship.warp.getY();
      }

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

    this.nextSpawnDelay = 0;
  }

  getShips(): Ship[] {
    return Array.from(this.ships.values());
  }

  hitTest(pixelX: number, pixelY: number, _canvasW: number, _canvasH: number): string | null {
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
      hullVariant: Math.floor(Math.random() * HULL_COUNT),
      pulsePhase: 0,
      driftPhaseX: Math.random() * Math.PI * 2,
      driftPhaseY: Math.random() * Math.PI * 2,
      driftSpeedX: 0.15 + Math.random() * 0.1,
      driftSpeedY: 0.2 + Math.random() * 0.12,
    };

    if (delay === 0) {
      warp.startWarpIn(BASE_X * canvasW, targetY * canvasH);
    }

    this.ships.set(agent.paneId, ship);
    this.spawnOrder.push(agent.paneId);
  }

  private spawnSubShip(
    sub: AgentVisualState,
    parentPaneId: string,
    _subIndex: number,
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
      hullVariant: Math.floor(Math.random() * HULL_COUNT),
      pulsePhase: 0,
      driftPhaseX: Math.random() * Math.PI * 2,
      driftPhaseY: Math.random() * Math.PI * 2,
      driftSpeedX: 0.18 + Math.random() * 0.1,
      driftSpeedY: 0.22 + Math.random() * 0.12,
    });
  }

  private updateShip(agent: AgentVisualState, targetY: number, _canvasW: number, _canvasH: number): void {
    const ship = this.ships.get(agent.paneId);
    if (!ship || ship.despawning) return;

    ship.state = agent.state;
    ship.stateColor = STATE_COLORS[agent.state] ?? '#9ca3af';
    ship.currentTool = agent.currentTool;
    ship.label = agent.label;
    ship.uptime = agent.uptime;
    ship.targetY = targetY;
    ship.overflowCount = 0;
  }

  private getAccentColor(index: number): string {
    if (index < ACCENT_PALETTES.length) {
      return ACCENT_PALETTES[index];
    }
    return this.shiftHue(ACCENT_PALETTES[0], ((index - ACCENT_PALETTES.length) * 60 + 30) % 360);
  }

  private shiftHue(hex: string, degrees: number): string {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) return hex;

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
