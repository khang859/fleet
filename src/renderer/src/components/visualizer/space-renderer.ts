import type { Ship } from './ships';
import { HULL_COUNT } from './ships';
import { ParticleSystem } from './particles';

type HullDrawFn = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;

const HULL_VARIANTS: HullDrawFn[] = [
  // 0: Arrow (original) — pointed nose, angled rear notch
  (ctx, x, y, w, h) => {
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(x + w, cy);
    ctx.lineTo(x + w * 0.3, y);
    ctx.lineTo(x, y + h * 0.25);
    ctx.lineTo(x, y + h * 0.75);
    ctx.lineTo(x + w * 0.3, y + h);
    ctx.closePath();
  },
  // 1: Dart — narrow elongated diamond with swept-back wings
  (ctx, x, y, w, h) => {
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(x + w, cy);
    ctx.lineTo(x + w * 0.45, y);
    ctx.lineTo(x, cy);
    ctx.lineTo(x + w * 0.45, y + h);
    ctx.closePath();
  },
  // 2: Wedge — wide triangle, flat front angled back
  (ctx, x, y, w, h) => {
    ctx.beginPath();
    ctx.moveTo(x + w, y + h * 0.3);
    ctx.lineTo(x + w, y + h * 0.7);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y);
    ctx.closePath();
  },
  // 3: Fighter — notched wings (top/bottom indents)
  (ctx, x, y, w, h) => {
    const cy = y + h / 2;
    ctx.beginPath();
    ctx.moveTo(x + w, cy);
    ctx.lineTo(x + w * 0.4, y);
    ctx.lineTo(x + w * 0.15, y + h * 0.2);
    ctx.lineTo(x + w * 0.15, y + h * 0.4);
    ctx.lineTo(x, cy);
    ctx.lineTo(x + w * 0.15, y + h * 0.6);
    ctx.lineTo(x + w * 0.15, y + h * 0.8);
    ctx.lineTo(x + w * 0.4, y + h);
    ctx.closePath();
  },
  // 4: Shuttle — blunt nose, boxy shape
  (ctx, x, y, w, h) => {
    ctx.beginPath();
    ctx.moveTo(x + w, y + h * 0.25);
    ctx.lineTo(x + w, y + h * 0.75);
    ctx.lineTo(x + w * 0.2, y + h * 0.85);
    ctx.lineTo(x, y + h * 0.7);
    ctx.lineTo(x, y + h * 0.3);
    ctx.lineTo(x + w * 0.2, y + h * 0.15);
    ctx.closePath();
  },
];

// Accent stripe configs per variant: [xOffset, yOffset from cy, width, height]
type StripeConfig = [number, number, number, number];
const STRIPE_CONFIGS: StripeConfig[] = [
  [0.4, -1, 0.3, 2],   // Arrow
  [0.35, -1, 0.3, 2],  // Dart
  [0.3, -1, 0.4, 2],   // Wedge
  [0.4, -1, 0.25, 2],  // Fighter
  [0.35, -1, 0.35, 2], // Shuttle
];

// Sanity check
if (HULL_VARIANTS.length !== HULL_COUNT) {
  throw new Error(`HULL_VARIANTS length (${HULL_VARIANTS.length}) must match HULL_COUNT (${HULL_COUNT})`);
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
        // Spawn particles behind the ship (left edge)
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

    // Apply tilt rotation for idle ships
    if (ship.tiltAngle !== 0) {
      const cx = ship.currentX;
      const cy2 = ship.currentY;
      ctx.translate(cx, cy2);
      ctx.rotate(ship.tiltAngle);
      ctx.translate(-cx, -cy2);
    }

    // Needs-permission pulsing glow
    if (ship.state === 'needs-permission') {
      const pulse = 0.3 + Math.sin(ship.pulsePhase) * 0.3;
      ctx.shadowColor = ship.stateColor;
      ctx.shadowBlur = 8 * pulse;
    }

    // Ship body (state color)
    ctx.fillStyle = ship.stateColor;
    const cy = y + h / 2;

    // Draw hull variant
    const variant = ship.hullVariant % HULL_VARIANTS.length;
    HULL_VARIANTS[variant](ctx, x, y, w, h);
    ctx.fill();

    // Accent stripe (cockpit / wing marking) — adjusted per variant
    const [sxOff, syOff, swPct, sH] = STRIPE_CONFIGS[variant];
    ctx.fillStyle = ship.accentColor;
    ctx.fillRect(
      Math.round(x + w * sxOff),
      Math.round(cy + syOff),
      Math.round(w * swPct),
      sH,
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
