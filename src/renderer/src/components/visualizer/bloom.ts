import { SPRITE_ATLAS } from './sprite-atlas';
import { isSpriteReady, getSpriteSheet } from './sprite-loader';
import type { Ship } from './ships';

/**
 * BloomPass — per-object glow effect using sprite overlay.
 */
export class BloomPass {
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
}
