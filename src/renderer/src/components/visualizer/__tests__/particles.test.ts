import { describe, it, expect } from 'vitest';
import { ParticleSystem, WarpEffect } from '../particles';

describe('ParticleSystem', () => {
  it('spawns particles at a given position', () => {
    const ps = new ParticleSystem();
    ps.spawn(100, 50, '#4ade80', 4);

    expect(ps.getParticles()).toHaveLength(4);
  });

  it('particles drift left and fade over time', () => {
    const ps = new ParticleSystem();
    ps.spawn(100, 50, '#4ade80', 1);

    const before = { ...ps.getParticles()[0] };
    ps.update(500);
    const after = ps.getParticles()[0];

    expect(after.x).toBeLessThan(before.x);
    expect(after.opacity).toBeLessThan(before.opacity);
  });

  it('removes dead particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(100, 50, '#4ade80', 1);

    ps.update(2000);

    expect(ps.getParticles()).toHaveLength(0);
  });

  it('respects global particle cap of 100', () => {
    const ps = new ParticleSystem();
    for (let i = 0; i < 30; i++) {
      ps.spawn(i * 10, 50, '#4ade80', 6);
    }

    expect(ps.getParticles().length).toBeLessThanOrEqual(100);
  });
});

describe('WarpEffect', () => {
  it('creates a warp-in streak', () => {
    const warp = new WarpEffect();
    warp.startWarpIn(200, 50);

    expect(warp.isActive()).toBe(true);
    expect(warp.getStretch()).toBeGreaterThan(1);
  });

  it('warp-in completes after ~500ms', () => {
    const warp = new WarpEffect();
    warp.startWarpIn(200, 50);

    warp.update(600);

    expect(warp.isActive()).toBe(false);
    expect(warp.getStretch()).toBe(1);
  });

  it('creates a warp-out streak that moves right', () => {
    const warp = new WarpEffect();
    warp.startWarpOut(200, 50);

    const xBefore = warp.getX();
    warp.update(200);
    const xAfter = warp.getX();

    expect(xAfter).toBeGreaterThan(xBefore);
  });

  it('warp-out completes and signals done', () => {
    const warp = new WarpEffect();
    warp.startWarpOut(200, 50);

    warp.update(600);

    expect(warp.isActive()).toBe(false);
    expect(warp.isDone()).toBe(true);
  });
});
