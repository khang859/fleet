import scSpriteSheetUrl from '../../assets/star-command-sprites.png';
import { SC_SPRITE_ATLAS } from './sc-sprite-atlas';
import type { SpriteRegion } from './sc-sprite-atlas';

let spriteSheet: HTMLImageElement | null = null;
let spriteReady = false;

export function loadScSpriteSheet(): void {
  if (spriteSheet) return;
  const img = new Image();
  img.src = scSpriteSheetUrl;
  img.onload = () => {
    spriteSheet = img;
    spriteReady = true;
  };
}

export function isScSpriteReady(): boolean {
  return spriteReady;
}

export function getScSpriteSheet(): HTMLImageElement | null {
  return spriteSheet;
}

export function getScSpriteSheetUrl(): string {
  return scSpriteSheetUrl;
}

/**
 * Extract a single sprite tile as a standalone data URL.
 * Required for CSS background-repeat on sprite sheet sub-regions,
 * since background-repeat tiles the entire sheet, not a sub-region.
 * Results are cached.
 */
const tileCache = new Map<string, string>();
export function getScTileUrl(key: string): string {
  const cached = tileCache.get(key);
  if (cached) return cached;
  if (!spriteSheet) return '';
  const region = SC_SPRITE_ATLAS[key];
  if (!region) return '';

  const canvas = document.createElement('canvas');
  canvas.width = region.w;
  canvas.height = region.h;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(spriteSheet, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h);
  const url = canvas.toDataURL('image/png');
  tileCache.set(key, url);
  return url;
}

export function getScFrame(region: SpriteRegion, elapsed: number): number {
  if (region.frames <= 1 || region.frameDuration <= 0) return 0;
  const totalDuration = region.frames * region.frameDuration;
  return Math.floor((elapsed % totalDuration) / region.frameDuration);
}

export function drawScSprite(
  ctx: CanvasRenderingContext2D,
  key: string,
  elapsed: number,
  dx: number,
  dy: number,
  dw?: number,
  dh?: number
): void {
  if (!spriteSheet) return;
  const region = SC_SPRITE_ATLAS[key];
  if (!region) return;
  const frame = getScFrame(region, elapsed);
  const framesPerRow = region.framesPerRow ?? region.frames;
  const col = frame % framesPerRow;
  const row = Math.floor(frame / framesPerRow);
  const sx = region.x + col * region.w;
  const sy = region.y + row * region.h;
  const w = dw ?? region.w;
  const h = dh ?? region.h;
  ctx.drawImage(spriteSheet, sx, sy, region.w, region.h, dx, dy, w, h);
}

export function drawScSpriteFrame(
  ctx: CanvasRenderingContext2D,
  key: string,
  frameIndex: number,
  dx: number,
  dy: number,
  dw?: number,
  dh?: number
): void {
  if (!spriteSheet) return;
  const region = SC_SPRITE_ATLAS[key];
  if (!region) return;
  const framesPerRow = region.framesPerRow ?? region.frames;
  const col = frameIndex % framesPerRow;
  const row = Math.floor(frameIndex / framesPerRow);
  const sx = region.x + col * region.w;
  const sy = region.y + row * region.h;
  const w = dw ?? region.w;
  const h = dh ?? region.h;
  ctx.drawImage(spriteSheet, sx, sy, region.w, region.h, dx, dy, w, h);
}
