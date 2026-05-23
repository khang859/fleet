import { describe, it, expect } from 'vitest';
import { isWindowsPath, isWslPath } from '../path-platform';

describe('isWindowsPath', () => {
  it('matches drive-letter paths with backslash', () => {
    expect(isWindowsPath('C:\\Users\\khang')).toBe(true);
  });
  it('matches drive-letter paths with forward slash', () => {
    expect(isWindowsPath('D:/projects/foo')).toBe(true);
  });
  it('matches lowercase drive letter', () => {
    expect(isWindowsPath('c:\\temp')).toBe(true);
  });
  it('rejects POSIX paths', () => {
    expect(isWindowsPath('/home/khang')).toBe(false);
  });
  it('rejects relative paths', () => {
    expect(isWindowsPath('./foo')).toBe(false);
  });
  it('rejects empty string', () => {
    expect(isWindowsPath('')).toBe(false);
  });
});

describe('isWslPath', () => {
  it('matches absolute POSIX paths', () => {
    expect(isWslPath('/home/khang')).toBe(true);
    expect(isWslPath('/mnt/c/Users/khang')).toBe(true);
  });
  it('rejects Windows paths', () => {
    expect(isWslPath('C:\\Users')).toBe(false);
  });
  it('rejects relative paths', () => {
    expect(isWslPath('home/khang')).toBe(false);
  });
});
