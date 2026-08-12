import { describe, expect, it } from 'vitest';
import { backgroundImagePatch, nextSlideshowFiles } from '../background-actions';
import {
  DEFAULT_TERMINAL_BACKGROUND,
  type TerminalBackgroundSlideshow
} from '../../../../shared/types';

const slideshow = (patch: Partial<TerminalBackgroundSlideshow>): TerminalBackgroundSlideshow => ({
  ...DEFAULT_TERMINAL_BACKGROUND.slideshow,
  ...patch
});

describe('backgroundImagePatch', () => {
  it('sets the path and turns the slideshow off, so the new picture actually shows', () => {
    expect(backgroundImagePatch('/img/a.png')).toEqual({
      imagePath: '/img/a.png',
      slideshow: { enabled: false }
    });
  });
});

describe('nextSlideshowFiles', () => {
  it('appends to an existing file list', () => {
    expect(
      nextSlideshowFiles(slideshow({ source: 'files', filePaths: ['/img/a.png'] }), ['/img/b.png'])
    ).toEqual({ source: 'files', filePaths: ['/img/a.png', '/img/b.png'] });
  });

  it('does not add the same picture twice', () => {
    expect(
      nextSlideshowFiles(slideshow({ source: 'files', filePaths: ['/img/a.png'] }), ['/img/a.png'])
    ).toEqual({ source: 'files', filePaths: ['/img/a.png'] });
  });

  it('dedupes within one batch of added paths', () => {
    expect(
      nextSlideshowFiles(slideshow({ source: 'files', filePaths: [] }), [
        '/img/a.png',
        '/img/a.png'
      ])
    ).toEqual({ source: 'files', filePaths: ['/img/a.png'] });
  });

  it('keeps the folder contents when switching a folder show over to a file list', () => {
    expect(
      nextSlideshowFiles(
        slideshow({ source: 'folder', folderPath: '/wall', filePaths: [] }),
        ['/img/new.png'],
        ['/wall/1.png', '/wall/2.png']
      )
    ).toEqual({ source: 'files', filePaths: ['/wall/1.png', '/wall/2.png', '/img/new.png'] });
  });

  it('ignores a stale file list left over from the last time the source was files', () => {
    expect(
      nextSlideshowFiles(
        slideshow({ source: 'folder', folderPath: '/wall', filePaths: ['/old/stale.png'] }),
        ['/img/new.png'],
        ['/wall/1.png']
      )
    ).toEqual({ source: 'files', filePaths: ['/wall/1.png', '/img/new.png'] });
  });

  it('says nothing about enabled, so adding never claims to have started the show', () => {
    const next = nextSlideshowFiles(slideshow({ source: 'files', filePaths: [] }), ['/img/a.png']);
    expect(Object.keys(next).sort()).toEqual(['filePaths', 'source']);
  });
});
