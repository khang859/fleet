type AuroraBand = {
  baseY: number;       // base vertical position (fraction of canvas height)
  hue: number;         // current hue in degrees
  phase: number;       // sine wave phase for vertical oscillation
  alpha: number;       // base alpha (0.02-0.04)
  heightFraction: number; // band height as fraction of canvas height
  cachedCanvas: OffscreenCanvas | null;
  lastRenderedHue: number;
};

export class AuroraBands {
  private bands: AuroraBand[] = [];
  private initialized = false;
  private cacheGeneration = 0;
  private renderWidth = 0;

  private init(): void {
    const count = 2 + Math.floor(Math.random() * 2); // 2-3 bands
    for (let i = 0; i < count; i++) {
      this.bands.push({
        baseY: 0.15 + (i / count) * 0.5 + (Math.random() - 0.5) * 0.1,
        hue: Math.random() * 360,
        phase: Math.random() * Math.PI * 2,
        alpha: 0.02 + Math.random() * 0.02,
        heightFraction: 0.08 + Math.random() * 0.06,
        cachedCanvas: null,
        lastRenderedHue: -999,
      });
    }
    this.initialized = true;
  }

  getBandCount(): number {
    return this.bands.length;
  }

  getBandCacheGeneration(): number {
    return this.cacheGeneration;
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

  private renderBandCache(band: AuroraBand, width: number, height: number): void {
    const bandHeight = Math.ceil(band.heightFraction * height);
    const canvas = new OffscreenCanvas(width, bandHeight);
    const offCtx = canvas.getContext('2d')!;

    const grad = offCtx.createLinearGradient(0, 0, 0, bandHeight);
    grad.addColorStop(0, `hsla(${band.hue}, 60%, 50%, 0)`);
    grad.addColorStop(0.5, `hsla(${band.hue}, 60%, 50%, ${band.alpha})`);
    grad.addColorStop(1, `hsla(${band.hue}, 60%, 50%, 0)`);

    offCtx.fillStyle = grad;
    offCtx.fillRect(0, 0, width, bandHeight);

    band.cachedCanvas = canvas;
    band.lastRenderedHue = band.hue;
  }

  render(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const widthChanged = width !== this.renderWidth;
    if (widthChanged) {
      this.renderWidth = width;
    }

    let regenerated = false;

    for (const band of this.bands) {
      const hueDelta = Math.abs(band.hue - band.lastRenderedHue);
      const needsRegen = band.cachedCanvas === null || hueDelta >= 5 || widthChanged;

      if (needsRegen) {
        this.renderBandCache(band, width, height);
        regenerated = true;
      }

      const oscillation = Math.sin(band.phase) * 20; // amplitude ~20px
      const y = band.baseY * height + oscillation;

      ctx.drawImage(band.cachedCanvas!, 0, y);
    }

    if (regenerated) {
      this.cacheGeneration++;
    }
  }
}
