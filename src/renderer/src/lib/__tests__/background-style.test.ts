import { describe, it, expect } from 'vitest';
import { backgroundLayerStyle, videoObjectFit } from '../background-style';

const plain = { blur: 0, fit: 'cover', edgeFadeX: 0, edgeFadeY: 0 } as const;

describe('backgroundLayerStyle', () => {
  it('draws an image as a CSS background, with its path encoded', () => {
    expect(backgroundLayerStyle(plain, '/home/k/a b.png')).toMatchObject({
      inset: 0,
      backgroundImage: 'url("fleet-image:///home/k/a%20b.png")',
      backgroundSize: 'cover',
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'center'
    });
  });

  it('repeats an image only when tiled', () => {
    expect(backgroundLayerStyle({ ...plain, fit: 'tile' }, '/a.png')).toMatchObject({
      backgroundSize: 'auto',
      backgroundRepeat: 'repeat'
    });
    expect(backgroundLayerStyle({ ...plain, fit: 'center' }, '/a.png')).toMatchObject({
      backgroundSize: 'auto',
      backgroundRepeat: 'no-repeat'
    });
  });

  it('leaves the picture of a video to the element inside the box', () => {
    const style = backgroundLayerStyle(plain, '/a.mp4');
    expect(style).not.toHaveProperty('backgroundImage');
    expect(style).not.toHaveProperty('backgroundSize');
  });

  it('reaches past the edges when blurred, for an image and a video alike', () => {
    for (const src of ['/a.png', '/a.mp4']) {
      expect(backgroundLayerStyle({ ...plain, blur: 8 }, src)).toMatchObject({
        inset: -16,
        filter: 'blur(8px)'
      });
    }
    expect(backgroundLayerStyle(plain, '/a.png').filter).toBeUndefined();
  });

  it('has no mask without an edge fade', () => {
    expect(backgroundLayerStyle(plain, '/a.mp4')).not.toHaveProperty('maskImage');
  });

  it('feathers one pair of edges with a single gradient', () => {
    const style = backgroundLayerStyle({ ...plain, edgeFadeX: 0.1 }, '/a.mp4');
    expect(style.maskImage).toBe(
      'linear-gradient(to right, transparent, #000 10.0%, #000 90.0%, transparent)'
    );
    expect(style).not.toHaveProperty('maskComposite');
  });

  it('intersects the two gradients so the corners fade too', () => {
    const style = backgroundLayerStyle({ ...plain, edgeFadeX: 0.1, edgeFadeY: 0.25 }, '/a.png');
    expect(style.maskImage).toBe(
      'linear-gradient(to right, transparent, #000 10.0%, #000 90.0%, transparent), ' +
        'linear-gradient(to bottom, transparent, #000 25.0%, #000 75.0%, transparent)'
    );
    expect(style.maskComposite).toBe('intersect');
  });
});

describe('videoObjectFit', () => {
  it('maps each fit to what a video can do', () => {
    expect(videoObjectFit('cover')).toBe('cover');
    expect(videoObjectFit('contain')).toBe('contain');
    expect(videoObjectFit('center')).toBe('none');
  });

  it('fills instead of tiling', () => {
    expect(videoObjectFit('tile')).toBe('cover');
  });
});
