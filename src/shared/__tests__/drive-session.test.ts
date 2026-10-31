import { describe, it, expect } from 'vitest';
import { deriveDebugPort, deriveRendererPort, sessionFilePath } from '../drive-session';

describe('deriveDebugPort', () => {
  it('returns a valid override port verbatim', () => {
    expect(deriveDebugPort('/any/path', '9333')).toBe(9333);
  });

  it('ignores an empty override and derives from the path', () => {
    const port = deriveDebugPort('/Users/x/fleet', '');
    expect(port).toBeGreaterThanOrEqual(31000);
    expect(port).toBeLessThan(39000);
  });

  it('ignores a non-numeric override', () => {
    const port = deriveDebugPort('/Users/x/fleet', 'not-a-port');
    expect(port).toBeGreaterThanOrEqual(31000);
  });

  it('is deterministic for the same path', () => {
    expect(deriveDebugPort('/a/b/c')).toBe(deriveDebugPort('/a/b/c'));
  });

  it('differs across worktree paths', () => {
    expect(deriveDebugPort('/wt/one')).not.toBe(deriveDebugPort('/wt/two'));
  });
});

describe('deriveRendererPort', () => {
  it('is the port after the checkout debug port', () => {
    expect(deriveRendererPort('/wt/one')).toBe(deriveDebugPort('/wt/one') + 1);
  });
});

describe('sessionFilePath', () => {
  it('places the session file under .fleet-drive', () => {
    expect(sessionFilePath('/repo')).toBe('/repo/.fleet-drive/session.json');
  });
});
