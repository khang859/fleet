import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_DIALOG_FILTERS,
  BACKGROUND_VIDEO_EXTENSIONS,
  backgroundMediaKind
} from '../background-media';
import { MEDIA_MIME_TYPES } from '../file-open';

describe('backgroundMediaKind', () => {
  it('tells a picture from a video by its extension', () => {
    expect(backgroundMediaKind('/a/sunset.jpg')).toBe('image');
    expect(backgroundMediaKind('/a/loop.mp4')).toBe('video');
    expect(backgroundMediaKind('/a/loop.webm')).toBe('video');
  });

  it('counts an animated image as an image', () => {
    expect(backgroundMediaKind('/a/rain.gif')).toBe('image');
    expect(backgroundMediaKind('/a/rain.webp')).toBe('image');
  });

  it('ignores the case of the extension', () => {
    expect(backgroundMediaKind('/a/CLIP.MOV')).toBe('video');
    expect(backgroundMediaKind('C:\\Users\\k\\Pic.PNG')).toBe('image');
  });

  it('goes by the last extension only', () => {
    expect(backgroundMediaKind('/a/archive.tar.mp4')).toBe('video');
    expect(backgroundMediaKind('/a/clip.mp4.txt')).toBeNull();
  });

  it('refuses anything that is neither', () => {
    expect(backgroundMediaKind('/a/logo.svg')).toBeNull();
    expect(backgroundMediaKind('/a/film.mkv')).toBeNull();
    expect(backgroundMediaKind('/a/noextension')).toBeNull();
    expect(backgroundMediaKind('/a/.mp4')).toBeNull();
    expect(backgroundMediaKind('')).toBeNull();
  });
});

describe('background video extensions', () => {
  it('are all ones fleet-media:// will serve', () => {
    for (const ext of BACKGROUND_VIDEO_EXTENSIONS) {
      expect(MEDIA_MIME_TYPES[ext]).toMatch(/^video\//);
    }
  });
});

describe('BACKGROUND_DIALOG_FILTERS', () => {
  it('offers every kind in one filter first, without leading dots', () => {
    const [all] = BACKGROUND_DIALOG_FILTERS;
    expect(all.extensions).toContain('gif');
    expect(all.extensions).toContain('mp4');
    for (const ext of all.extensions) expect(backgroundMediaKind(`/a/file.${ext}`)).not.toBeNull();
  });
});
