import { SPRITE_ATLAS } from './sprite-atlas';
import { isSpriteReady, drawSprite } from './sprite-loader';

const ASTEROID_KEYS = ['asteroid-chunky', 'asteroid-jagged', 'asteroid-smooth'] as const;
const ASTEROID_RENDER_SIZE = 32; // 16px sprites drawn at 2× scale

type Asteroid = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  variant: number; // index into ASTEROID_KEYS
  opacity: number;
  targetOpacity: number;
  animElapsed: number;
  // Fallback fields
  rotation: number;
  rotationSpeed: number;
  vertices: { x: number; y: number }[];
  size: number;
};

export class AsteroidField {
  private asteroids: Asteroid[] = [];

  update(deltaMs: number, width: number, height: number, hasPermissionNeeded: boolean): void {
    const dt = deltaMs / 1000;

    if (hasPermissionNeeded && this.asteroids.length < 8) {
      if (Math.random() < dt * 0.5) {
        this.spawnAsteroid(width, height);
      }
    }

    for (const a of this.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rotation += a.rotationSpeed * dt;
      a.animElapsed += deltaMs;

      a.targetOpacity = hasPermissionNeeded ? 0.3 : 0;
      a.opacity += (a.targetOpacity - a.opacity) * dt * 2;

      // Wrap around
      const half = ASTEROID_RENDER_SIZE / 2;
      if (a.x < -half * 2) a.x = width + half;
      if (a.x > width + half * 2) a.x = -half;
      if (a.y < -half * 2) a.y = height + half;
      if (a.y > height + half * 2) a.y = -half;
    }

    this.asteroids = this.asteroids.filter((a) => a.opacity > 0.01);
  }

  private spawnAsteroid(width: number, height: number): void {
    const size = 4 + Math.random() * 8;
    const vertexCount = 3 + Math.floor(Math.random() * 4);
    const vertices: { x: number; y: number }[] = [];
    for (let i = 0; i < vertexCount; i++) {
      const angle = (i / vertexCount) * Math.PI * 2;
      const r = size * (0.5 + Math.random() * 0.5);
      vertices.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
    }

    this.asteroids.push({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 20,
      vy: (Math.random() - 0.5) * 15,
      variant: Math.floor(Math.random() * ASTEROID_KEYS.length),
      opacity: 0.01,
      targetOpacity: 0.3,
      animElapsed: Math.random() * 5000,
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 1,
      vertices,
      size,
    });
  }

  render(ctx: CanvasRenderingContext2D): void {
    const useSprites = isSpriteReady();

    for (const a of this.asteroids) {
      if (a.opacity < 0.01) continue;

      ctx.save();
      ctx.globalAlpha = a.opacity;

      if (useSprites) {
        const key = ASTEROID_KEYS[a.variant];
        const region = SPRITE_ATLAS[key];
        if (region) {
          const half = ASTEROID_RENDER_SIZE / 2;
          drawSprite(
            ctx, region, a.animElapsed,
            Math.round(a.x - half), Math.round(a.y - half),
            ASTEROID_RENDER_SIZE, ASTEROID_RENDER_SIZE,
          );
        }
      } else {
        // Fallback: procedural polygon
        ctx.fillStyle = '#555555';
        ctx.translate(Math.round(a.x), Math.round(a.y));
        ctx.rotate(a.rotation);
        ctx.beginPath();
        ctx.moveTo(a.vertices[0].x, a.vertices[0].y);
        for (let i = 1; i < a.vertices.length; i++) {
          ctx.lineTo(a.vertices[i].x, a.vertices[i].y);
        }
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    }
  }
}
