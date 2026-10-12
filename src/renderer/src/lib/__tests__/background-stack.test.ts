import { describe, it, expect } from 'vitest';
import {
  EMPTY_BACKGROUND_STACK,
  backgroundStackReducer,
  type BackgroundStack,
  type BackgroundStackEvent
} from '../background-stack';

function run(events: BackgroundStackEvent[], from = EMPTY_BACKGROUND_STACK): BackgroundStack {
  return events.reduce(backgroundStackReducer, from);
}

const showImage = (src: string, fade = true): BackgroundStackEvent => ({
  type: 'show',
  src,
  ready: true,
  fade
});
const showVideo = (src: string, fade = true): BackgroundStackEvent => ({
  type: 'show',
  src,
  ready: false,
  fade
});
const ready = (src: string, fade = true): BackgroundStackEvent => ({ type: 'ready', src, fade });

describe('backgroundStackReducer', () => {
  it('shows the first image with nothing to fade from', () => {
    expect(run([showImage('/a.png')])).toEqual({
      top: { src: '/a.png', ready: true },
      under: null
    });
  });

  it('mounts the first video unseen until it has a frame', () => {
    expect(run([showVideo('/a.mp4')])).toEqual({
      top: { src: '/a.mp4', ready: false },
      under: null
    });
    expect(run([showVideo('/a.mp4'), ready('/a.mp4')])).toEqual({
      top: { src: '/a.mp4', ready: true },
      under: null
    });
  });

  it('keeps the old background untouched until the new video is ready', () => {
    const waiting = run([showImage('/a.png'), showVideo('/b.mp4')]);
    expect(waiting).toEqual({ top: { src: '/b.mp4', ready: false }, under: '/a.png' });

    const crossing = backgroundStackReducer(waiting, ready('/b.mp4'));
    expect(crossing).toEqual({ top: { src: '/b.mp4', ready: true }, under: '/a.png' });

    expect(backgroundStackReducer(crossing, { type: 'settled', src: '/b.mp4' })).toEqual({
      top: { src: '/b.mp4', ready: true },
      under: null
    });
  });

  it('crossfades straight away between two images', () => {
    expect(run([showImage('/a.png'), showImage('/b.png')])).toEqual({
      top: { src: '/b.png', ready: true },
      under: '/a.png'
    });
  });

  it('cuts between images when there is no fade', () => {
    expect(run([showImage('/a.png'), showImage('/b.png', false)])).toEqual({
      top: { src: '/b.png', ready: true },
      under: null
    });
  });

  it('holds the old background for a video even when the swap is a cut', () => {
    const waiting = run([showImage('/a.png'), showVideo('/b.mp4', false)]);
    expect(waiting.under).toBe('/a.png');

    expect(backgroundStackReducer(waiting, ready('/b.mp4', false))).toEqual({
      top: { src: '/b.mp4', ready: true },
      under: null
    });
  });

  it('never puts a video nobody saw underneath the next one', () => {
    const stack = run([showImage('/a.png'), showVideo('/b.mp4'), showVideo('/c.mp4')]);
    expect(stack).toEqual({ top: { src: '/c.mp4', ready: false }, under: '/a.png' });
  });

  it('ignores a video that reports in after it was replaced', () => {
    const stack = run([showImage('/a.png'), showVideo('/b.mp4'), showVideo('/c.mp4')]);
    expect(backgroundStackReducer(stack, ready('/b.mp4'))).toBe(stack);
    expect(backgroundStackReducer(stack, { type: 'settled', src: '/b.mp4' })).toBe(stack);
    expect(backgroundStackReducer(stack, { type: 'failed', src: '/b.mp4' })).toBe(stack);
  });

  it('goes back to the background still on screen without reloading it', () => {
    const stack = run([
      showVideo('/a.mp4'),
      ready('/a.mp4'),
      showVideo('/b.mp4'),
      showVideo('/a.mp4')
    ]);
    expect(stack).toEqual({ top: { src: '/a.mp4', ready: true }, under: null });
  });

  it('does nothing when asked to show what it is already showing', () => {
    const stack = run([showImage('/a.png')]);
    expect(backgroundStackReducer(stack, showImage('/a.png'))).toBe(stack);
  });

  it('keeps showing the old background when the new one cannot be played', () => {
    const stack = run([
      showImage('/a.png'),
      showVideo('/bad.mp4'),
      { type: 'failed', src: '/bad.mp4' }
    ]);
    expect(stack).toEqual({ top: { src: '/a.png', ready: true }, under: null });
  });

  it('is left with nothing when the only background cannot be played', () => {
    expect(run([showVideo('/bad.mp4'), { type: 'failed', src: '/bad.mp4' }])).toEqual(
      EMPTY_BACKGROUND_STACK
    );
  });

  it('drops a video that breaks while it is fading out', () => {
    const stack = run([showVideo('/a.mp4'), ready('/a.mp4'), showImage('/b.png')]);
    expect(backgroundStackReducer(stack, { type: 'failed', src: '/a.mp4' })).toEqual({
      top: { src: '/b.png', ready: true },
      under: null
    });
  });

  it('clears everything when there is no background', () => {
    const stack = run([showImage('/a.png'), showImage('/b.png')]);
    expect(
      backgroundStackReducer(stack, { type: 'show', src: null, ready: false, fade: true })
    ).toEqual(EMPTY_BACKGROUND_STACK);
  });
});
