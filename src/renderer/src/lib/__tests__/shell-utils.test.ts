import { describe, it, expect } from 'vitest';
import { quotePathForShell } from '../shell-utils';

describe('quotePathForShell', () => {
  it('single-quotes POSIX paths', () => {
    expect(quotePathForShell('/home/user/file.txt', 'darwin')).toBe("'/home/user/file.txt'");
  });

  it('escapes single quotes in POSIX paths', () => {
    expect(quotePathForShell("/home/user/it's a file.txt", 'linux')).toBe(
      "'/home/user/it'\\''s a file.txt'"
    );
  });

  it('double-quotes Windows paths (backslashes are NOT escaped)', () => {
    expect(quotePathForShell('C:\\Users\\user\\file.txt', 'win32')).toBe(
      '"C:\\Users\\user\\file.txt"'
    );
  });

  it('escapes double quotes in Windows paths', () => {
    expect(quotePathForShell('C:\\path with "quotes"\\file.txt', 'win32')).toBe(
      '"C:\\path with \\"quotes\\"\\file.txt"'
    );
  });
});
