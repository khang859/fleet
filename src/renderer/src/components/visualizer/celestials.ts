import { SPRITE_ATLAS } from './sprite-atlas';
import { isSpriteReady, drawSprite } from './sprite-loader';

type BodyKind = 'gas-giant' | 'rocky-world' | 'moon';

type CelestialBody = {
  x: number;
  y: number;
  kind: BodyKind;
  speed: number;
  opacity: number;
  animElapsed: number;
  // Fallback fields (used when sprites not ready)
  radius: number;
  hue: number;
};

const BODY_SPRITES: Record<BodyKind, { key: string; renderW: number; renderH: number }> = {
  'gas-giant': { key: 'celestial-gas-giant', renderW: 64, renderH: 64 },
  'rocky-world': { key: 'celestial-rocky-world', renderW: 64, renderH: 64 },
  'moon': { key: 'celestial-moon', renderW: 32, renderH: 32 },
};

const BODY_KINDS: BodyKind[] = ['gas-giant', 'rocky-world', 'moon'];

function randomBody(canvasWidth: number, canvasHeight: number, startOnScreen: boolean): CelestialBody {
  const kind = BODY_KINDS[Math.floor(Math.random() * BODY_KINDS.length)];
  const info = BODY_SPRITES[kind];
  const radius = info.renderW / 2;

  return {
    x: startOnScreen
      ? radius + Math.random() * (canvasWidth - radius * 2)
      : canvasWidth + radius + Math.random() * 200,
    y: radius + Math.random() * (canvasHeight - radius * 2),
    kind,
    speed: 1 + Math.random(),
    opacity: 0.08 + Math.random() * 0.07,
    animElapsed: Math.random() * 10000,
    radius,
    hue: Math.floor(Math.random() * 360),
  };
}

type SpaceStation = {
  x: number;
  y: number;
  speed: number;
  active: boolean;
  spawnTimer: number;
  nextSpawn: number;
  animElapsed: number;
};

export class CelestialBodies {
  private bodies: CelestialBody[] = [];
  private initialized = false;
  private station: SpaceStation = {
    x: 0,
    y: 0,
    speed: 0,
    active: false,
    spawnTimer: 0,
    nextSpawn: 30 + Math.random() * 30,
    animElapsed: 0,
  };

  update(deltaMs: number, canvasWidth: number, canvasHeight: number): void {
    if (!this.initialized) {
      const count = 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < count; i++) {
        this.bodies.push(randomBody(canvasWidth, canvasHeight, true));
      }
      this.initialized = true;
    }

    const dt = deltaMs / 1000;
    for (const body of this.bodies) {
      body.x -= body.speed * dt;
      body.animElapsed += deltaMs;

      if (body.x + body.radius < 0) {
        const newBody = randomBody(canvasWidth, canvasHeight, false);
        Object.assign(body, newBody);
      }
    }

    // Space station logic
    if (this.station.active) {
      this.station.x -= this.station.speed * dt;
      this.station.animElapsed += deltaMs;
      if (this.station.x < -48) {
        this.station.active = false;
        this.station.spawnTimer = 0;
        this.station.nextSpawn = 30 + Math.random() * 30;
      }
    } else {
      this.station.spawnTimer += dt;
      if (this.station.spawnTimer >= this.station.nextSpawn) {
        this.station.active = true;
        this.station.x = canvasWidth + 10;
        this.station.y = 20 + Math.random() * (canvasHeight - 40);
        this.station.speed = canvasWidth / 15;
        this.station.animElapsed = 0;
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const useSprites = isSpriteReady();

    for (const body of this.bodies) {
      const info = BODY_SPRITES[body.kind];
      const x = Math.round(body.x - info.renderW / 2);
      const y = Math.round(body.y - info.renderH / 2);

      ctx.globalAlpha = body.opacity;

      if (useSprites) {
        const region = SPRITE_ATLAS[info.key];
        if (region) {
          drawSprite(ctx, region, body.animElapsed, x, y, info.renderW, info.renderH);
        }
      } else {
        // Fallback: colored circle
        const grad = ctx.createRadialGradient(
          Math.round(body.x) - body.radius * 0.2,
          Math.round(body.y) - body.radius * 0.2,
          0,
          Math.round(body.x),
          Math.round(body.y),
          body.radius,
        );
        grad.addColorStop(0, `hsl(${body.hue}, 20%, 35%)`);
        grad.addColorStop(1, `hsl(${body.hue}, 15%, 15%)`);
        ctx.beginPath();
        ctx.arc(Math.round(body.x), Math.round(body.y), body.radius, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      ctx.globalAlpha = 1;
    }

    // Render space station
    if (this.station.active) {
      const stationRegion = SPRITE_ATLAS['celestial-space-station'];
      const sx = Math.round(this.station.x - 24);
      const sy = Math.round(this.station.y - 24);

      ctx.globalAlpha = 0.25;

      if (useSprites && stationRegion) {
        drawSprite(ctx, stationRegion, this.station.animElapsed, sx, sy, 48, 48);
      } else {
        // Fallback: procedural station
        const px = Math.round(this.station.x);
        const py = Math.round(this.station.y);
        ctx.fillStyle = '#8899aa';
        ctx.fillRect(px - 2, py - 2, 4, 4);
        ctx.fillRect(px - 7, py - 1, 14, 2);
        ctx.fillStyle = '#556688';
        ctx.fillRect(px - 7, py - 3, 3, 6);
        ctx.fillRect(px + 4, py - 3, 3, 6);
        ctx.fillStyle = '#8899aa';
        ctx.fillRect(px, py - 5, 1, 3);
      }

      ctx.globalAlpha = 1;
    }
  }
}
