import { describe, expect, it } from 'vitest';
import { formatDuration, formatSize, getBasename } from '../file-display';

describe('getBasename', () => {
  it('takes the last segment of a POSIX or Windows path', () => {
    expect(getBasename('/home/k/clip.mp4')).toBe('clip.mp4');
    expect(getBasename('C:\\Users\\k\\clip.mp4')).toBe('clip.mp4');
    expect(getBasename('clip.mp4')).toBe('clip.mp4');
  });
});

describe('formatSize', () => {
  it('steps from bytes to KB to MB', () => {
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatDuration', () => {
  it('prints minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(75.9)).toBe('1:15');
  });

  it('adds hours only when there are some', () => {
    expect(formatDuration(3599)).toBe('59:59');
    expect(formatDuration(3725)).toBe('1:02:05');
  });
});
