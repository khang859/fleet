import { describe, expect, it } from 'vitest';
import {
  getFileExtension,
  getPaneTypeForFilePath,
  isAudioFilePath,
  isBinaryBlockedFilePath,
  isOpenablePaneType,
  MEDIA_MIME_TYPES
} from '../file-open';

describe('file-open helpers', () => {
  it('extracts lowercase extensions from paths', () => {
    expect(getFileExtension('/tmp/Photo.PNG')).toBe('.png');
  });

  it('returns image pane type for image files', () => {
    expect(getPaneTypeForFilePath('/tmp/example.webp')).toBe('image');
  });

  it('returns markdown pane type for markdown files', () => {
    expect(getPaneTypeForFilePath('/tmp/README.md')).toBe('markdown');
  });

  it('returns file pane type for non-image, non-markdown files', () => {
    expect(getPaneTypeForFilePath('/tmp/index.ts')).toBe('file');
  });

  it('returns pdf pane type for pdf files', () => {
    expect(getPaneTypeForFilePath('/tmp/report.pdf')).toBe('pdf');
  });

  it('does not block pdf files (now openable)', () => {
    expect(isBinaryBlockedFilePath('/tmp/report.pdf')).toBe(false);
  });

  it('detects blocked binary files', () => {
    expect(isBinaryBlockedFilePath('/tmp/archive.zip')).toBe(true);
    expect(isBinaryBlockedFilePath('/tmp/report.txt')).toBe(false);
  });

  it('returns media pane type for every video and audio file Chromium plays', () => {
    for (const name of ['a.mp4', 'a.m4v', 'a.mov', 'a.webm', 'a.mkv', 'A.MP4', 'a.mp3', 'a.wav']) {
      expect(getPaneTypeForFilePath(`/tmp/${name}`)).toBe('media');
    }
  });

  it('tells sound-only files from video by extension', () => {
    for (const name of ['a.mp3', 'a.m4a', 'a.aac', 'a.wav', 'a.flac', 'A.OGG']) {
      expect(isAudioFilePath(`/tmp/${name}`)).toBe(true);
    }
    for (const name of ['a.mp4', 'a.webm', 'a.mkv', 'a.txt', 'noext']) {
      expect(isAudioFilePath(`/tmp/${name}`)).toBe(false);
    }
  });

  it('does not block media it can open, and still blocks what it cannot', () => {
    for (const ext of Object.keys(MEDIA_MIME_TYPES)) {
      expect(isBinaryBlockedFilePath(`/tmp/clip${ext}`)).toBe(false);
    }
    expect(isBinaryBlockedFilePath('/tmp/clip.avi')).toBe(true);
  });

  it('accepts only the pane types a file can open as', () => {
    for (const type of ['file', 'image', 'markdown', 'pdf', 'media']) {
      expect(isOpenablePaneType(type)).toBe(true);
    }
    for (const type of ['terminal', 'agent', 'nope', undefined, null, 3]) {
      expect(isOpenablePaneType(type)).toBe(false);
    }
  });
});
