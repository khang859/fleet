type AuroraBand = {
  baseY: number;       // base vertical position (fraction of canvas height)
  hue: number;         // current hue in degrees
  phase: number;       // sine wave phase for vertical oscillation
  alpha: number;       // base alpha (0.02-0.04)
  heightFraction: number; // band height as fraction of canvas height
};

export class AuroraBands {
  private bands: AuroraBand[] = [];
  private initialized = false;

  private init(): void {
    const count = 2 + Math.floor(Math.random() * 2); // 2-3 bands
    for (let i = 0; i < count; i++) {
      this.bands.push({
        baseY: 0.15 + (i / count) * 0.5 + (Math.random() - 0.5) * 0.1,
        hue: Math.random() * 360,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.02 + Math.random() * 0.02,
        heightFraction: 0.08 + Math.random() * 0.06,
      });
    }
    this.initialized = true;
  }

  update(deltaMs: number): void {
    if (!this.initialized) this.init();

    const dt = deltaMs / 1000;
    for (const band of this.bands) {
      // Slow hue shift: 2 degrees per second
      band.hue = (band.hue + 2 * dt) % 360;
      // Vertical oscillation phase: period ~30s
      band.phase += ((2 * Math.PI) / 30) * dt;
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const w = ctx.canvas.width / (window.devicePixelRatio || 1);
    const h = ctx.canvas.height / (window.devicePixelRatio || 1);

    for (const band of this.bands) {
      const oscillation = Math.sin(band.phase) * 20; // amplitude ~20px
      const y = band.baseY * h + oscillation;
      const bandHeight = band.heightFraction * h;

      const grad = ctx.createLinearGradient(0, y, 0, y + bandHeight);
      grad.addColorStop(0, `hsla(${band.hue}, 60%, 50%, 0)`);
      grad.addColorStop(0.5, `hsla(${band.hue}, 60%, 50%, ${band.alpha})`);
      grad.addColorStop(1, `hsla(${band.hue}, 60%, 50%, 0)`);

      ctx.fillStyle = grad;
      ctx.fillRect(0, y, w, bandHeight);
    }
  }
}
