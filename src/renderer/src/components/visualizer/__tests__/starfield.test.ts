import { describe, it, expect, beforeAll } from 'vitest';
import { Starfield } from '../starfield';

// Polyfill OffscreenCanvas for Node.js test environment
beforeAll(() => {
  if (typeof globalThis.OffscreenCanvas === 'undefined') {
    class MockOffscreenCanvas {
      readonly width: number;
      readonly height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext(_type: string): object {
        return {
          clearRect: () => {},
          fillRect: () => {},
          drawImage: () => {},
          beginPath: () => {},
          moveTo: () => {},
          lineTo: () => {},
          stroke: () => {},
          set filter(_v: string) {},
          get filter() { return 'none'; },
          set fillStyle(_v: string) {},
          get fillStyle() { return ''; },
          set strokeStyle(_v: string) {},
          get strokeStyle() { return ''; },
          set lineWidth(_v: number) {},
          get lineWidth() { return 1; },
        };
      }
    }
    (globalThis as Record<string, unknown>).OffscreenCanvas = MockOffscreenCanvas;
  }
});

describe('Starfield', () => {
  it('creates 3 layers with correct star counts for a given area', () => {
    const sf = new Starfield(200, 100);
    const layers = sf.getLayers();

    expect(layers).toHaveLength(3);
    expect(layers[0].stars.length).toBeGreaterThan(0);
    expect(layers[1].stars.length).toBeGreaterThan(0);
    expect(layers[2].stars.length).toBeGreaterThanOrEqual(layers[0].stars.length);
  });

  it('scrolls stars left and wraps around', () => {
    const sf = new Starfield(100, 100);
    const layers = sf.getLayers();
    const firstStarX = layers[2].stars[0].x;

    sf.update(1000);

    const newX = layers[2].stars[0].x;
    expect(newX).not.toBe(firstStarX);
  });

  it('stars that scroll off-screen wrap to the right', () => {
    const sf = new Starfield(100, 100);
    const layers = sf.getLayers();

    layers[2].stars[0].x = -1;
    sf.update(0);
    sf.update(16);
    for (const star of layers[2].stars) {
      expect(star.x).toBeGreaterThan(-10);
    }
  });

  it('persists star positions across resize', () => {
    const sf = new Starfield(200, 100);
    const countBefore = sf.getLayers()[0].stars.length;

    sf.resize(400, 200);
    const countAfter = sf.getLayers()[0].stars.length;

    expect(countAfter).toBeGreaterThanOrEqual(countBefore);
  });

  // Task 1: Far-layer OffscreenCanvas cache
  it('caches far-layer stars in an OffscreenCanvas buffer', () => {
    const sf = new Starfield(200, 100);
    expect(sf.getFarLayerCache()).toBeInstanceOf(OffscreenCanvas);
  });

  it('does not regenerate far-layer cache when no stars wrap', () => {
    const sf = new Starfield(200, 100);
    const cache1 = sf.getFarLayerCache();
    sf.update(16);
    const cache2 = sf.getFarLayerCache();
    expect(cache2).toBe(cache1);
  });

  it('regenerates far-layer cache when a star wraps', () => {
    const sf = new Starfield(200, 100);
    const cache1 = sf.getFarLayerCache();
    sf.getLayers()[0].stars[0].x = -10;
    sf.update(16);
    const cache2 = sf.getFarLayerCache();
    expect(cache2).not.toBe(cache1);
  });

  // Task 2: Constellation edge caching
  it('caches constellation edges and recomputes on timer', () => {
    const sf = new Starfield(200, 100);
    const midStars = sf.getLayers()[1].stars;
    if (midStars.length >= 2) {
      midStars[0].x = 50;
      midStars[0].y = 50;
      midStars[1].x = 55;
      midStars[1].y = 50;
    }
    sf.update(16);
    const edges1 = sf.getConstellationEdges();
    expect(edges1.length).toBeGreaterThan(0);
    sf.update(16);
    const edges2 = sf.getConstellationEdges();
    expect(edges2).toBe(edges1);
    sf.update(500);
    const edges3 = sf.getConstellationEdges();
    expect(edges3).not.toBe(edges1);
  });

  // Task 3: Pre-computed fillStyle strings
  it('pre-computes cachedFillStyle for non-twinkling stars', () => {
    const sf = new Starfield(200, 100);
    const layers = sf.getLayers();
    for (const layer of layers) {
      for (const star of layer.stars) {
        if (star.twinkleSpeed === 0) {
          expect(star.cachedFillStyle).toBeDefined();
          expect(star.cachedFillStyle).toMatch(/^rgba\(/);
        }
      }
    }
  });
});
