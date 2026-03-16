import { SPRITE_ATLAS } from './sprite-atlas';
import { isSpriteReady, drawSprite } from './sprite-loader';

const MAX_PARTICLES = 100;
const MIN_LIFETIME = 0.5;
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
  animElapsed: number;
};

export class ParticleSystem {
  private particles: Particle[] = [];

  spawn(x: number, y: number, color: string, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) {
        this.particles.shift();
      }

      const maxLife = MIN_LIFETIME + Math.random() * (MAX_LIFETIME - MIN_LIFETIME);
      this.particles.push({
        x,
        y: y + (Math.random() - 0.5) * 4,
        vx: -(20 + Math.random() * 30),
        vy: (Math.random() - 0.5) * 8,
        opacity: 0.8 + Math.random() * 0.2,
        size: 1 + Math.random() * 2,
        color,
        life: maxLife,
        maxLife,
        animElapsed: 0,
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
      p.animElapsed += deltaMs;
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
    const useSprites = isSpriteReady();
    const puffRegion = useSprites ? SPRITE_ATLAS['particle-engine-puff'] : null;

    for (const p of this.particles) {
      ctx.globalAlpha = p.opacity;

      if (puffRegion) {
        // Sprite-based puff: 4×4 sprite drawn at ~2× scale
        const renderSize = Math.round(p.size * 3);
        drawSprite(
          ctx, puffRegion, p.animElapsed,
          Math.round(p.x - renderSize / 2),
          Math.round(p.y - renderSize / 2),
          renderSize, renderSize,
          p.color,
        );
      } else {
        // Fallback: colored pixel
        ctx.fillStyle = p.color;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.size), Math.round(p.size));
      }
    }
    ctx.globalAlpha = 1;
  }
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export class WarpEffect {
  private active = false;
  private done = false;
  private mode: 'in' | 'out' = 'in';
  private elapsed = 0;
  private duration = 500;
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
    this.currentX = -20;
    this.currentStretch = 8;
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
      this.currentStretch = 8 - 7 * eased;
    } else {
      const eased = easeOutCubic(t);
      this.currentX = this.targetX + eased * 300;
      this.currentStretch = 1 + eased * 7;
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

  getElapsed(): number {
    return this.elapsed;
  }

  getMode(): 'in' | 'out' {
    return this.mode;
  }

  render(ctx: CanvasRenderingContext2D, color: string, width: number, height: number): void {
    if (!this.active) return;

    const useSprites = isSpriteReady();

    if (useSprites) {
      // Use warp streak sprite for the warp effect
      const streakRegion = SPRITE_ATLAS['particle-warp-streak'];
      if (streakRegion) {
        const stretchedWidth = width * this.currentStretch;
        const x = Math.round(this.currentX - stretchedWidth / 2);
        const y = Math.round(this.targetY - height / 2);

        ctx.globalAlpha = 0.9;
        drawSprite(
          ctx, streakRegion, this.elapsed,
          x, y, Math.round(stretchedWidth), Math.round(height),
          color,
        );

        // Spawn burst at target position during warp-in
        if (this.mode === 'in' && this.elapsed < 200) {
          const burstRegion = SPRITE_ATLAS['particle-spawn-burst'];
          if (burstRegion) {
            const burstAlpha = 1 - this.elapsed / 200;
            ctx.globalAlpha = burstAlpha * 0.8;
            const burstSize = 24;
            drawSprite(
              ctx, burstRegion, this.elapsed,
              Math.round(this.targetX - burstSize / 2),
              Math.round(this.targetY - burstSize / 2),
              burstSize, burstSize,
            );
          }
        }

        ctx.globalAlpha = 1;
        return;
      }
    }

    // Fallback: procedural warp
    const stretchedWidth = width * this.currentStretch;
    const x = Math.round(this.currentX - stretchedWidth / 2);
    const y = Math.round(this.targetY - height / 2);

    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, Math.round(stretchedWidth), Math.round(height));

    if (this.mode === 'in' && this.elapsed < 200) {
      const burstAlpha = 1 - this.elapsed / 200;
      ctx.globalAlpha = burstAlpha * 0.6;
      ctx.fillStyle = '#ffffff';
      const burstSize = 12;
      ctx.fillRect(
        Math.round(this.targetX - burstSize / 2),
        Math.round(this.targetY - burstSize / 2),
        burstSize,
        burstSize,
      );
    }

    ctx.globalAlpha = 1;
  }
}
