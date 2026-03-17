import { describe, it, expect } from 'vitest';
import { AuroraBands } from '../aurora';

function mockCtx(): CanvasRenderingContext2D {
  return {
    globalAlpha: 1,
    drawImage: () => {},
  } as unknown as CanvasRenderingContext2D;
}

describe('AuroraBands', () => {
  it('initializes 2-3 bands on first update', () => {
    const aurora = new AuroraBands();
    aurora.update(16);
    expect(aurora.getBandCount()).toBeGreaterThanOrEqual(2);
    expect(aurora.getBandCount()).toBeLessThanOrEqual(3);
  });

  it('caches band canvases and reuses them across frames', () => {
    const aurora = new AuroraBands();
    aurora.update(16);
    aurora.render(mockCtx(), 200, 100);
    const cache1 = aurora.getBandCacheGeneration();
    aurora.update(16);
    aurora.render(mockCtx(), 200, 100);
    const cache2 = aurora.getBandCacheGeneration();
    expect(cache2).toBe(cache1);
  });

  it('regenerates band cache after hue shifts ≥5 degrees', () => {
    const aurora = new AuroraBands();
    aurora.update(16);
    aurora.render(mockCtx(), 200, 100);
    const cache1 = aurora.getBandCacheGeneration();
    aurora.update(2500);
    aurora.render(mockCtx(), 200, 100);
    const cache2 = aurora.getBandCacheGeneration();
    expect(cache2).toBeGreaterThan(cache1);
  });
});
