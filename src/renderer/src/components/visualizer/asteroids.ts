type Asteroid = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotationSpeed: number;
  vertices: { x: number; y: number }[];
  size: number;
  opacity: number;
  targetOpacity: number;
};

export class AsteroidField {
  private asteroids: Asteroid[] = [];

  update(deltaMs: number, width: number, height: number, hasPermissionNeeded: boolean): void {
    const dt = deltaMs / 1000;

    if (hasPermissionNeeded && this.asteroids.length < 8) {
      // Spawn new asteroids occasionally
      if (Math.random() < dt * 0.5) {
        this.spawnAsteroid(width, height);
      }
    }

    for (const a of this.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rotation += a.rotationSpeed * dt;

      // Fade toward target
      a.targetOpacity = hasPermissionNeeded ? 0.3 : 0;
      a.opacity += (a.targetOpacity - a.opacity) * dt * 2;

      // Wrap around
      if (a.x < -a.size * 2) a.x = width + a.size;
      if (a.x > width + a.size * 2) a.x = -a.size;
      if (a.y < -a.size * 2) a.y = height + a.size;
      if (a.y > height + a.size * 2) a.y = -a.size;
    }

    // Remove fully faded asteroids
    this.asteroids = this.asteroids.filter((a) => a.opacity > 0.01);
  }

  private spawnAsteroid(width: number, height: number): void {
    const vertexCount = 3 + Math.floor(Math.random() * 4); // 3-6 vertices
    const size = 4 + Math.random() * 8;
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
      rotation: Math.random() * Math.PI * 2,
      rotationSpeed: (Math.random() - 0.5) * 1,
      vertices,
      size,
      opacity: 0.01,
      targetOpacity: 0.3,
    });
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const a of this.asteroids) {
      if (a.opacity < 0.01) continue;
      ctx.save();
      ctx.globalAlpha = a.opacity;
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
      ctx.restore();
    }
  }
}
