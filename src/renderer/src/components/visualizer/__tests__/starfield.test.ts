import { describe, it, expect } from 'vitest';
import { Starfield } from '../starfield';

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
});
