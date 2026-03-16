type ShootingStar = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  length: number;
  brightness: number;
  life: number;
  maxLife: number;
};

const MAX_ACTIVE = 3;
const TRAIL_SEGMENTS = 4;

export class ShootingStarSystem {
  private stars: ShootingStar[] = [];
  private spawnTimer = 0;
  private nextSpawn = 3000 + Math.random() * 4000;

  update(deltaMs: number, width: number, height: number): void {
    // Spawn logic
    this.spawnTimer += deltaMs;
    if (this.spawnTimer >= this.nextSpawn && this.stars.length < MAX_ACTIVE) {
      this.spawn(width, height);
      this.spawnTimer = 0;
      this.nextSpawn = 3000 + Math.random() * 4000;
    }

    // Update existing stars
    const dt = deltaMs / 1000;
    for (const star of this.stars) {
      star.x += star.vx * dt;
      star.y += star.vy * dt;
      star.life += deltaMs;
    }

    // Remove dead stars
    this.stars = this.stars.filter((s) => s.life < s.maxLife);
  }

  private spawn(width: number, height: number): void {
    // Start from a random position along the top or right edge
    const startX = Math.random() * width * 0.8 + width * 0.1;
    const startY = Math.random() * height * 0.3;

    // Slight downward angle, moving left-to-right or right-to-left
    const speed = 300 + Math.random() * 200;
    const angle = (Math.PI / 6) + Math.random() * (Math.PI / 6); // 30-60 degrees
    const direction = Math.random() > 0.5 ? 1 : -1;

    this.stars.push({
      x: startX,
      y: startY,
      vx: Math.cos(angle) * speed * direction,
      vy: Math.sin(angle) * speed,
      length: 20 + Math.random() * 30,
      brightness: 0.8 + Math.random() * 0.2,
      life: 0,
      maxLife: 300 + Math.random() * 500, // 0.3-0.8s
    });
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const star of this.stars) {
      const lifeRatio = star.life / star.maxLife;
      // Fade in quickly, fade out at end
      const fade = lifeRatio < 0.1 ? lifeRatio / 0.1 : lifeRatio > 0.7 ? (1 - lifeRatio) / 0.3 : 1;
      const alpha = star.brightness * fade;

      // Compute trail direction (opposite of velocity)
      const speed = Math.sqrt(star.vx * star.vx + star.vy * star.vy);
      const dx = -star.vx / speed;
      const dy = -star.vy / speed;

      // Bright head pixel
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, Math.min(1, alpha))})`;
      ctx.fillRect(Math.round(star.x), Math.round(star.y), 2, 2);

      // Trailing pixels at decreasing opacity
      for (let i = 1; i <= TRAIL_SEGMENTS; i++) {
        const trailAlpha = alpha * (1 - i / (TRAIL_SEGMENTS + 1)) * 0.7;
        const segLen = (star.length / TRAIL_SEGMENTS) * i;
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.max(0, Math.min(1, trailAlpha))})`;
        ctx.fillRect(
          Math.round(star.x + dx * segLen),
          Math.round(star.y + dy * segLen),
          1,
          1,
        );
      }
    }
  }
}
