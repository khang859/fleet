import { describe, it, expect } from 'vitest';
import { isWindowsPath, isWslPath, basename, join } from '../path-platform';

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

describe('basename', () => {
  it('returns last segment of POSIX path', () => {
    expect(basename('/home/khang/dev/fleet', 'posix')).toBe('fleet');
  });
  it('returns last segment of Windows path with backslashes', () => {
    expect(basename('C:\\Users\\khang\\dev', 'win32')).toBe('dev');
  });
  it('returns last segment of Windows path with forward slashes', () => {
    expect(basename('C:/Users/khang/dev', 'win32')).toBe('dev');
  });
  it('returns last segment for WSL context (POSIX semantics)', () => {
    expect(basename('/home/khang/dev', { kind: 'wsl', distro: 'Ubuntu' })).toBe('dev');
  });
  it('strips trailing slashes', () => {
    expect(basename('/home/khang/', 'posix')).toBe('khang');
    expect(basename('C:\\Users\\', 'win32')).toBe('Users');
  });
  it('returns "Shell" for empty or root-only paths', () => {
    expect(basename('/', 'posix')).toBe('Shell');
    expect(basename('', 'posix')).toBe('Shell');
    expect(basename('C:\\', 'win32')).toBe('Shell');
  });
});

describe('join', () => {
  it('joins POSIX with forward slash', () => {
    expect(join('posix', '/home', 'khang', 'dev')).toBe('/home/khang/dev');
  });
  it('joins Windows with backslash', () => {
    expect(join('win32', 'C:\\', 'Users', 'khang')).toBe('C:\\Users\\khang');
  });
  it('joins WSL with forward slash', () => {
    expect(join({ kind: 'wsl', distro: 'Ubuntu' }, '/home', 'khang')).toBe('/home/khang');
  });
  it('collapses doubled separators', () => {
    expect(join('posix', '/home/', '/khang/', 'dev')).toBe('/home/khang/dev');
    expect(join('win32', 'C:\\Users\\', '\\khang')).toBe('C:\\Users\\khang');
  });
  it('ignores empty segments', () => {
    expect(join('posix', '/home', '', 'khang')).toBe('/home/khang');
  });
});
