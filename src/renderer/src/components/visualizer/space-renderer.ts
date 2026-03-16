import type { Ship } from './ships';
import { ParticleSystem } from './particles';
import { getParentSprite, getSubagentSprite } from './sprite-atlas';
import { isSpriteReady, drawSprite } from './sprite-loader';

/** Map agent state to sprite animation name */
function getAnimState(ship: Ship): 'idle' | 'thrust' | 'warp-in' | 'warp-out' {
  if (ship.warp.isActive()) {
    return ship.despawning ? 'warp-out' : 'warp-in';
  }
  switch (ship.state) {
    case 'working':
    case 'reading':
    case 'waiting':
      return 'thrust';
    default:
      return 'idle';
  }
}

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
        this.particles.spawn(
          ship.currentX - ship.width / 2 - 2,
          ship.currentY,
          ship.accentColor,
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
    // Warp active — use hull warp sprites if available, else fallback to WarpEffect
    if (ship.warp.isActive()) {
      if (isSpriteReady()) {
        this.renderWarpSprite(ctx, ship);
      } else {
        ship.warp.render(ctx, ship.stateColor, ship.width, ship.height);
      }
      return;
    }

    if (ship.despawning) return;

    const x = Math.round(ship.currentX - ship.width / 2);
    const y = Math.round(ship.currentY - ship.height / 2);
    const w = ship.width;
    const h = ship.height;

    ctx.save();

    // Apply tilt rotation for idle ships
    if (ship.tiltAngle !== 0) {
      const cx = ship.currentX;
      const cy = ship.currentY;
      ctx.translate(cx, cy);
      ctx.rotate(ship.tiltAngle);
      ctx.translate(-cx, -cy);
    }

    // Needs-permission pulsing glow
    if (ship.state === 'needs-permission') {
      const pulse = 0.3 + Math.sin(ship.pulsePhase) * 0.3;
      ctx.shadowColor = ship.stateColor;
      ctx.shadowBlur = 8 * pulse;
    }

    if (isSpriteReady()) {
      const anim = getAnimState(ship);
      const region = ship.isSubAgent
        ? getSubagentSprite(ship.hullVariant, anim)
        : getParentSprite(ship.hullVariant, anim);

      if (region) {
        drawSprite(ctx, region, ship.animElapsed, x, y, w, h, ship.stateColor);
      } else {
        ctx.fillStyle = ship.stateColor;
        ctx.fillRect(x, y, w, h);
      }
    } else {
      ctx.fillStyle = ship.stateColor;
      ctx.fillRect(x, y, w, h);
    }

    ctx.restore();

    // Overflow badge for subagents
    if (ship.overflowCount > 0) {
      const cy = y + h / 2;
      ctx.fillStyle = '#ffffff';
      ctx.font = '8px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${ship.overflowCount}`, x + w + 2, cy);
    }

    // Uptime badges
    if (ship.uptime > 0) {
      const badgeX = x + w / 2;
      const badgeY = y - 4;
      ctx.fillStyle = ship.accentColor;

      if (ship.uptime >= 7200) {
        ctx.fillRect(Math.round(badgeX - 2), Math.round(badgeY), 2, 2);
        ctx.fillRect(Math.round(badgeX), Math.round(badgeY + 2), 2, 2);
        ctx.fillRect(Math.round(badgeX + 2), Math.round(badgeY), 2, 2);
      } else if (ship.uptime >= 1800) {
        ctx.fillRect(Math.round(badgeX - 2), Math.round(badgeY), 2, 2);
        ctx.fillRect(Math.round(badgeX + 2), Math.round(badgeY), 2, 2);
      } else if (ship.uptime >= 300) {
        ctx.fillRect(Math.round(badgeX), Math.round(badgeY), 2, 2);
      }
    }
  }

  /** Render the hull-specific warp-in/warp-out sprite at the warp position. */
  private renderWarpSprite(ctx: CanvasRenderingContext2D, ship: Ship): void {
    const anim = ship.despawning ? 'warp-out' : 'warp-in';
    const region = ship.isSubAgent
      ? getSubagentSprite(ship.hullVariant, anim)
      : getParentSprite(ship.hullVariant, anim);

    if (!region) {
      // No warp sprite found — fall back to procedural
      ship.warp.render(ctx, ship.stateColor, ship.width, ship.height);
      return;
    }

    // Position comes from WarpEffect (handles the slide-in/slide-out interpolation)
    const x = Math.round(ship.warp.getX() - ship.width / 2);
    const y = Math.round(ship.warp.getY() - ship.height / 2);

    // Use warp elapsed time so the 4-frame sequence plays through once
    const warpElapsed = ship.warp.getElapsed();

    ctx.save();
    drawSprite(ctx, region, warpElapsed, x, y, ship.width, ship.height, ship.stateColor);
    ctx.restore();
  }

  clearTrails(): void {
    this.particles.clear();
    this.trailTimers.clear();
  }
}
