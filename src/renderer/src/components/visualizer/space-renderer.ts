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
