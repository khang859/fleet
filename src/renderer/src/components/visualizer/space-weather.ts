type WeatherParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  opacity: number;
  size: number;
  life: number;
  maxLife: number;
};

export class SpaceWeather {
  private particles: WeatherParticle[] = [];
  private spawnTimer = 0;

  update(deltaMs: number, width: number, height: number, workingCount: number): void {
    // Only spawn when 3+ agents working
    if (workingCount >= 3) {
      this.spawnTimer += deltaMs;
      const spawnRate = 50 + (workingCount - 3) * 20; // ms between spawns
      while (this.spawnTimer >= spawnRate && this.particles.length < 50) {
        this.spawnParticle(width, height);
        this.spawnTimer -= spawnRate;
      }
    }

    // Update existing particles
    const dt = deltaMs / 1000;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      p.opacity = Math.max(0, (p.life / p.maxLife) * 0.4);
    }
    let writeIdx = 0;
    for (let i = 0; i < this.particles.length; i++) {
      if (this.particles[i].life > 0) {
        this.particles[writeIdx] = this.particles[i];
        writeIdx++;
      }
    }
    this.particles.length = writeIdx;
  }

  private spawnParticle(width: number, height: number): void {
    const life = 1 + Math.random() * 1.5;
    this.particles.push({
      x: width + 10,
      y: Math.random() * height,
      vx: -(200 + Math.random() * 300),
      vy: (Math.random() - 0.5) * 40,
      opacity: 0.3 + Math.random() * 0.1,
      size: 1 + Math.random() * 2,
      life,
      maxLife: life
    });
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const p of this.particles) {
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = '#ff8844'; // orange dust tint
      ctx.fillRect(Math.round(p.x), Math.round(p.y), Math.round(p.size), Math.round(p.size));
    }
    ctx.globalAlpha = 1;
  }
}
