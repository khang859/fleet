import { SPRITE_ATLAS } from './sprite-atlas';
import { isSpriteReady, getSpriteSheet } from './sprite-loader';
import type { Ship } from './ships';

/**
 * BloomPass — per-object glow effect using sprite overlay, with fallback
 * to the old full-canvas blur approach when sprites aren't loaded.
 */
export class BloomPass {
  private offCanvas: OffscreenCanvas;
  private offCtx: OffscreenCanvasRenderingContext2D;

  constructor(width: number, height: number) {
    this.offCanvas = new OffscreenCanvas(Math.ceil(width / 2), Math.ceil(height / 2));
    this.offCtx = this.offCanvas.getContext('2d')!;
  }

  resize(width: number, height: number): void {
    this.offCanvas.width = Math.ceil(width / 2);
    this.offCanvas.height = Math.ceil(height / 2);
  }

  /** Render per-object glow sprites behind ships. Call BEFORE ship rendering. */
  renderShipGlow(ctx: CanvasRenderingContext2D, ships: Ship[]): void {
    if (!isSpriteReady()) return;

    const sheet = getSpriteSheet();
    const glowRegion = SPRITE_ATLAS['effect-bloom-glow'];
    if (!sheet || !glowRegion) return;

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.35;

    for (const ship of ships) {
      if (ship.despawning || ship.warp.isActive()) continue;

      // Only glow for active states
      if (ship.state === 'idle' || ship.state === 'walking' || ship.state === 'not-agent') continue;

      // Draw glow sprite centered on ship, scaled larger than the ship
      const glowSize = Math.max(ship.width, ship.height) * 2;
      const gx = Math.round(ship.currentX - glowSize / 2);
      const gy = Math.round(ship.currentY - glowSize / 2);

      ctx.drawImage(
        sheet,
        glowRegion.x, glowRegion.y, glowRegion.w, glowRegion.h,
        gx, gy, glowSize, glowSize,
      );
    }

    ctx.restore();
  }

  /** Fallback full-canvas bloom when sprites aren't loaded. */
  render(ctx: CanvasRenderingContext2D): void {
    // Skip full-canvas bloom when sprites are available (per-object glow is used instead)
    if (isSpriteReady()) return;

    const hw = this.offCanvas.width;
    const hh = this.offCanvas.height;

    this.offCtx.clearRect(0, 0, hw, hh);
    this.offCtx.filter = 'blur(4px) brightness(1.5)';
    this.offCtx.drawImage(ctx.canvas, 0, 0, hw, hh);
    this.offCtx.filter = 'none';

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = 0.3;
    const canvasW = ctx.canvas.width;
    const canvasH = ctx.canvas.height;
    ctx.drawImage(this.offCanvas, 0, 0, canvasW, canvasH);
    ctx.restore();
  }
}
