type BodyType = 'ringed' | 'cratered';

type CelestialBody = {
  x: number;
  y: number;
  radius: number;
  speed: number;
  opacity: number;
  hue: number;
  type: BodyType;
  craters: { dx: number; dy: number; r: number }[];
};

function randomBody(canvasWidth: number, canvasHeight: number, startOnScreen: boolean): CelestialBody {
  const radius = 20 + Math.random() * 40;
  const type: BodyType = Math.random() > 0.5 ? 'ringed' : 'cratered';

  const craters: { dx: number; dy: number; r: number }[] = [];
  if (type === 'cratered') {
    const count = 2 + Math.floor(Math.random() * 2); // 2-3 craters
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * radius * 0.6;
      craters.push({
        dx: Math.cos(angle) * dist,
        dy: Math.sin(angle) * dist,
        r: 2 + Math.random() * (radius * 0.15),
      });
    }
  }

  return {
    x: startOnScreen
      ? radius + Math.random() * (canvasWidth - radius * 2)
      : canvasWidth + radius + Math.random() * 200,
    y: radius + Math.random() * (canvasHeight - radius * 2),
    radius,
    speed: 1 + Math.random(),
    opacity: 0.08 + Math.random() * 0.07,
    hue: Math.floor(Math.random() * 360),
    type,
    craters,
  };
}

type SpaceStation = {
  x: number;
  y: number;
  speed: number;
  active: boolean;
  spawnTimer: number;
  nextSpawn: number;
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
    nextSpawn: 30 + Math.random() * 30, // 30-60 seconds
  };

  update(deltaMs: number, canvasWidth: number, canvasHeight: number): void {
    if (!this.initialized) {
      const count = 1 + Math.floor(Math.random() * 2); // 1-2
      for (let i = 0; i < count; i++) {
        this.bodies.push(randomBody(canvasWidth, canvasHeight, true));
      }
      this.initialized = true;
    }

    const dt = deltaMs / 1000;
    for (const body of this.bodies) {
      body.x -= body.speed * dt;

      if (body.x + body.radius < 0) {
        const newBody = randomBody(canvasWidth, canvasHeight, false);
        body.x = newBody.x;
        body.y = newBody.y;
        body.radius = newBody.radius;
        body.speed = newBody.speed;
        body.opacity = newBody.opacity;
        body.hue = newBody.hue;
        body.type = newBody.type;
        body.craters = newBody.craters;
      }
    }

    // Space station logic
    if (this.station.active) {
      this.station.x -= this.station.speed * dt;
      if (this.station.x < -20) {
        this.station.active = false;
        this.station.spawnTimer = 0;
        this.station.nextSpawn = 30 + Math.random() * 30;
      }
    } else {
      this.station.spawnTimer += dt;
      if (this.station.spawnTimer >= this.station.nextSpawn) {
        // Spawn station at right edge, traverse in ~15s
        this.station.active = true;
        this.station.x = canvasWidth + 10;
        this.station.y = 20 + Math.random() * (canvasHeight - 40);
        this.station.speed = canvasWidth / 15; // cross screen in ~15s
      }
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const body of this.bodies) {
      const x = Math.round(body.x);
      const y = Math.round(body.y);

      ctx.globalAlpha = body.opacity;

      // Body gradient
      const grad = ctx.createRadialGradient(
        x - body.radius * 0.2, y - body.radius * 0.2, 0,
        x, y, body.radius,
      );
      grad.addColorStop(0, `hsl(${body.hue}, 20%, 35%)`);
      grad.addColorStop(1, `hsl(${body.hue}, 15%, 15%)`);

      ctx.beginPath();
      ctx.arc(x, y, body.radius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();

      if (body.type === 'ringed') {
        // Thin ring as an elliptical arc
        ctx.beginPath();
        ctx.ellipse(x, y, body.radius * 1.5, body.radius * 0.3, -0.2, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${body.hue}, 25%, 50%, ${body.opacity * 0.6})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // Craters: small darker circles
        for (const crater of body.craters) {
          ctx.beginPath();
          ctx.arc(x + crater.dx, y + crater.dy, crater.r, 0, Math.PI * 2);
          ctx.fillStyle = `hsla(${body.hue}, 15%, 10%, 0.4)`;
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;
    }

    // Render space station
    if (this.station.active) {
      const sx = Math.round(this.station.x);
      const sy = Math.round(this.station.y);
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#8899aa';

      // Central module (4x4)
      ctx.fillRect(sx - 2, sy - 2, 4, 4);
      // Horizontal beam (14x2)
      ctx.fillRect(sx - 7, sy - 1, 14, 2);
      // Left solar panel (3x6)
      ctx.fillStyle = '#556688';
      ctx.fillRect(sx - 7, sy - 3, 3, 6);
      // Right solar panel (3x6)
      ctx.fillRect(sx + 4, sy - 3, 3, 6);
      // Top antenna (1x3)
      ctx.fillStyle = '#8899aa';
      ctx.fillRect(sx, sy - 5, 1, 3);

      ctx.globalAlpha = 1;
    }
  }
}
