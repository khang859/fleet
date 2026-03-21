import { describe, expect, it } from 'vitest';
import { resolveBootstrapWorkspacePath } from '../workspace-path';

describe('resolveBootstrapWorkspacePath', () => {
  it('keeps the dev cwd when it points at a real workspace', () => {
    expect(
      resolveBootstrapWorkspacePath({
        cwd: '/Users/test/project',
        isPackaged: false,
        homeDir: '/Users/test'
      })
    ).toBe('/Users/test/project');
  });

  it('falls back to PWD when a packaged app starts with cwd at root', () => {
    expect(
      resolveBootstrapWorkspacePath({
        cwd: '/',
        pwd: '/Users/test/project',
        isPackaged: true,
        homeDir: '/Users/test'
      })
    ).toBe('/Users/test/project');
  });

  it('falls back to the home directory when packaged launch context is unusable', () => {
    expect(
      resolveBootstrapWorkspacePath({
        cwd: '/',
        pwd: '/',
        isPackaged: true,
        homeDir: '/Users/test'
      })
    ).toBe('/Users/test');
  });
});
