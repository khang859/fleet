import { describe, expect, it } from 'vitest';
import { getFileExtension, getPaneTypeForFilePath, isBinaryBlockedFilePath } from '../file-open';

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
});
