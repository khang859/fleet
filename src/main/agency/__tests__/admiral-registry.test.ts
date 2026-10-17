import { describe, expect, it } from 'vitest';
import { AdmiralRegistry } from '../admiral-registry';

const WINDOW_A = 1;
const WINDOW_B = 2;

/** Who holds `repoId`, asked the way another pane would: by trying to claim it. */
function ownerOf(registry: AdmiralRegistry, repoId: string): string | null {
  const probe = registry.claim({ repoId, paneId: 'probe' }, 99);
  if (probe.ok) {
    registry.release('probe');
    return null;
  }
  return probe.ownerPaneId;
}

describe('AdmiralRegistry', () => {
  it('gives a repository to one pane and names it to any other', () => {
    const registry = new AdmiralRegistry();
    expect(registry.claim({ repoId: 'r1', paneId: 'p1' }, WINDOW_A)).toEqual({ ok: true });
    expect(registry.claim({ repoId: 'r1', paneId: 'p1' }, WINDOW_A)).toEqual({ ok: true });
    expect(registry.claim({ repoId: 'r1', paneId: 'p2' }, WINDOW_B)).toEqual({
      ok: false,
      ownerPaneId: 'p1'
    });
    expect(ownerOf(registry, 'r1')).toBe('p1');
  });

  it('frees the repository when its pane goes', () => {
    const registry = new AdmiralRegistry();
    registry.claim({ repoId: 'r1', paneId: 'p1' }, WINDOW_A);
    registry.release('p2');
    expect(ownerOf(registry, 'r1')).toBe('p1');
    registry.release('p1');
    expect(registry.claim({ repoId: 'r1', paneId: 'p2' }, WINDOW_A)).toEqual({ ok: true });
  });

  it('lets a pane hold one repository at a time', () => {
    const registry = new AdmiralRegistry();
    registry.claim({ repoId: 'r1', paneId: 'p1' }, WINDOW_A);
    registry.claim({ repoId: 'r2', paneId: 'p1' }, WINDOW_A);
    expect(ownerOf(registry, 'r1')).toBeNull();
    expect(ownerOf(registry, 'r2')).toBe('p1');
  });

  it("gives up only the closing window's claims", () => {
    const registry = new AdmiralRegistry();
    registry.claim({ repoId: 'r1', paneId: 'p1' }, WINDOW_A);
    registry.claim({ repoId: 'r2', paneId: 'p2' }, WINDOW_B);
    registry.releaseOwner(WINDOW_A);
    expect(ownerOf(registry, 'r1')).toBeNull();
    expect(ownerOf(registry, 'r2')).toBe('p2');
  });
});
