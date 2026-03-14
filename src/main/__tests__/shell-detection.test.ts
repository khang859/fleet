import { describe, it, expect, vi } from 'vitest';
import { getDefaultShell } from '../shell-detection';

describe('getDefaultShell', () => {
  it('returns SHELL env var on non-win32 platforms', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', env: { SHELL: '/bin/zsh' } });
    expect(getDefaultShell()).toBe('/bin/zsh');
    vi.unstubAllGlobals();
  });

  it('falls back to /bin/zsh when SHELL is unset on non-win32', () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', env: {} });
    expect(getDefaultShell()).toBe('/bin/zsh');
    vi.unstubAllGlobals();
  });
});
