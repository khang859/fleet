import { describe, it, expect } from 'vitest';
import { buildBwrapArgv } from '../sandbox';

describe('buildBwrapArgv', () => {
  it('binds / read-only and the workspace writable, so writes outside fail', () => {
    const argv = buildBwrapArgv(['/bin/bash', '-c', 'echo hi'], {
      writableRoots: ['/home/u/project'],
      denyNetwork: true
    });
    const s = argv.join(' ');
    // Whole filesystem read-only…
    expect(s).toContain('--ro-bind / /');
    // …except the workspace which is writable.
    expect(s).toContain('--bind /home/u/project /home/u/project');
    // Network is severed.
    expect(s).toContain('--unshare-net');
    // The real command comes after the -- separator.
    const sep = argv.indexOf('--');
    expect(argv.slice(sep + 1)).toEqual(['/bin/bash', '-c', 'echo hi']);
  });

  it('omits --unshare-net when network is allowed', () => {
    const argv = buildBwrapArgv(['true'], { writableRoots: [], denyNetwork: false });
    expect(argv).not.toContain('--unshare-net');
  });
});
