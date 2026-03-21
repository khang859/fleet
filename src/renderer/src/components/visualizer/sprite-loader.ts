import spriteSheetUrl from '../../assets/sprites.png';
import type { SpriteRegion } from './sprite-atlas';

let spriteSheet: HTMLImageElement | null = null;
let spriteReady = false;

/** Load the sprite sheet once. Safe to call multiple times. */
export function loadSpriteSheet(): void {
  if (spriteSheet) return;
  const img = new Image();
  img.src = spriteSheetUrl;
  img.onload = () => {
    spriteSheet = img;
    spriteReady = true;
  };
}

export function isSpriteReady(): boolean {
  return spriteReady;
}

export function getSpriteSheet(): HTMLImageElement | null {
  return spriteSheet;
}

// Tint cache: key → offscreen canvas with tinted frame
const tintCache = new Map<string, CanvasImageSource>();
const TINT_CANVAS_SIZE = 64; // max sprite dimension we need to tint
let tintCanvas: OffscreenCanvas | null = null;

function ensureTintCanvas(): void {
  if (!tintCanvas) {
    tintCanvas = new OffscreenCanvas(TINT_CANVAS_SIZE, TINT_CANVAS_SIZE);
  }
}

/** Get a tinted version of a sprite frame (lazy-cached). */
function getTintedFrame(
  region: SpriteRegion,
  frameIndex: number,
  tintColor: string,
  cacheKey: string
): CanvasImageSource | null {
  if (!spriteSheet) return null;

  const cached = tintCache.get(cacheKey);
  if (cached) return cached;

  ensureTintCanvas();

  // Create a result canvas sized to the sprite
  const result = new OffscreenCanvas(region.w, region.h);
  const rctx = result.getContext('2d')!;

  // Draw the original sprite frame
  const sx = region.x + frameIndex * region.w;
  rctx.clearRect(0, 0, region.w, region.h);
  rctx.drawImage(spriteSheet, sx, region.y, region.w, region.h, 0, 0, region.w, region.h);

  // Apply tint using source-atop
  rctx.globalCompositeOperation = 'source-atop';
  rctx.globalAlpha = 0.4;
  rctx.fillStyle = tintColor;
  rctx.fillRect(0, 0, region.w, region.h);
  rctx.globalCompositeOperation = 'source-over';
  rctx.globalAlpha = 1;

  tintCache.set(cacheKey, result);
  return result;
}

/** Compute the current animation frame index. */
export function getFrame(region: SpriteRegion, elapsed: number): number {
  if (region.frames <= 1 || region.frameDuration <= 0) return 0;
  const totalDuration = region.frames * region.frameDuration;
  return Math.floor((elapsed % totalDuration) / region.frameDuration);
}

/** Draw a sprite region at the given position, optionally tinted. */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  region: SpriteRegion,
  elapsed: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  tintColor?: string
): void {
  if (!spriteSheet) return;

  const frame = getFrame(region, elapsed);

  if (tintColor) {
    const cacheKey = `${region.x}-${region.y}-${frame}-${tintColor}`;
    const tinted = getTintedFrame(region, frame, tintColor, cacheKey);
    if (tinted) {
      ctx.drawImage(tinted, 0, 0, region.w, region.h, dx, dy, dw, dh);
      return;
    }
  }

  // Draw untinted
  const sx = region.x + frame * region.w;
  ctx.drawImage(spriteSheet, sx, region.y, region.w, region.h, dx, dy, dw, dh);
}

/** Draw a raw sprite frame (no tinting, no animation). */
export function drawSpriteFrame(
  ctx: CanvasRenderingContext2D,
  region: SpriteRegion,
  frame: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  if (!spriteSheet) return;
  const sx = region.x + frame * region.w;
  ctx.drawImage(spriteSheet, sx, region.y, region.w, region.h, dx, dy, dw, dh);
}

/** Clear tint cache (e.g., on workspace switch). */
export function clearTintCache(): void {
  tintCache.clear();
}
